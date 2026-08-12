//! Dropbox (`dropbox`) folder scoping: `{folders:[…]}`.
//!
//! The folder is read from the request JSON — the buffered body on
//! `api.dropboxapi.com` RPC endpoints, the `Dropbox-API-Arg` header on
//! `content.dropboxapi.com`. A request is in scope iff every path it names is
//! equal to, or a descendant of, an allowed folder (segment-boundary prefix
//! match; case-insensitive). Unlike GitHub's exact repo match, folder scopes
//! nest, so the two matchers are deliberately separate.

use serde_json::Value;

use super::path_safety::has_traversal;
use super::ScopeVerdict;
use crate::gateway::strip_port;
use crate::policy::MatchInput;

/// The folder path(s) a Dropbox request addresses.
enum PathSet {
    /// No resource named — an account / no-arg endpoint.
    None,
    /// Concrete folder paths (all must be in scope).
    Paths(Vec<String>),
    /// A path-shaped field is present but not a string, or a batch entry we
    /// cannot extract a path from — fail closed.
    Unparseable,
}

pub(super) fn dropbox_scope(
    host: &str,
    path: &str,
    input: &MatchInput<'_>,
    allowed: &[String],
) -> ScopeVerdict {
    let host = strip_port(host);
    let json = if host == "content.dropboxapi.com" {
        // File-content endpoints carry the folder in the `Dropbox-API-Arg`
        // header; the body is the file itself and is never buffered.
        match dropbox_arg_header(input.headers) {
            Some(v) => v,
            None => return ScopeVerdict::Indeterminate,
        }
    } else if host == "api.dropboxapi.com" {
        // RPC endpoints carry the folder in the JSON body.
        if input.body_truncated {
            return ScopeVerdict::Indeterminate; // over-cap → unevaluable
        }
        match input.body {
            // Scoped RPC that reached here unbuffered → fail closed (should not
            // happen: `needs_body` buffers these).
            None => return ScopeVerdict::Indeterminate,
            // A no-arg (empty) body names no folder; whether that is allowed is
            // decided by the endpoint allowlist in the `PathSet::None` arm.
            Some([]) => Value::Null,
            Some(b) => match serde_json::from_slice::<Value>(b) {
                Ok(v) => v,
                Err(_) => return ScopeVerdict::Indeterminate,
            },
        }
    } else {
        // Any other Dropbox host carrying a scope: unrecognized → fail closed.
        return ScopeVerdict::Indeterminate;
    };

    match dropbox_paths(&json) {
        PathSet::Paths(paths) => {
            if paths.iter().all(|p| folder_in_scope(p, allowed)) {
                ScopeVerdict::InScope
            } else {
                ScopeVerdict::OutOfScope
            }
        }
        // No path field found. On the content host every op addresses a
        // resource, so a path we could not find is fail-closed. On the RPC host
        // a path-less body is in scope ONLY for endpoints known to address no
        // folder (account/space/check and `*/continue` cursor pagination); any
        // other path-less scoped RPC may address a resource through a field we
        // don't parse (e.g. `shared_folder_id`, `options.path`), so it is
        // fail-closed — mirroring GitHub's numeric-id / GraphQL treatment.
        PathSet::None => {
            if host == "api.dropboxapi.com" && is_non_resource_rpc(path) {
                ScopeVerdict::InScope
            } else {
                ScopeVerdict::Indeterminate
            }
        }
        PathSet::Unparseable => ScopeVerdict::Indeterminate,
    }
}

/// Dropbox RPC endpoints that address no folder resource, so a path-less body
/// on them is in scope even while a folder scope is set: the account / space /
/// check endpoints, and `*/continue` cursor-pagination calls (the opaque cursor
/// — obtained from an already-scope-checked listing — identifies the page, not
/// a path). Every other RPC endpoint is treated as potentially
/// resource-addressed and fails closed on a path-less body.
fn is_non_resource_rpc(path: &str) -> bool {
    let path = path.split(['?', '#']).next().unwrap_or(path);
    let path = path.trim_end_matches('/');
    matches!(
        path,
        "/2/users/get_current_account"
            | "/2/users/get_space_usage"
            | "/2/check/user"
            | "/2/check/app"
    ) || path.ends_with("/continue")
}

fn dropbox_arg_header(headers: Option<&hyper::HeaderMap>) -> Option<Value> {
    let s = headers?.get("dropbox-api-arg")?.to_str().ok()?;
    serde_json::from_str(s).ok()
}

/// Extract every folder path a Dropbox arg object names — `path`, `from_path`,
/// `to_path` (move/copy check BOTH), and each `entries[]` element (batch). A
/// non-object arg (e.g. `null` for get_current_account) names no path.
fn dropbox_paths(json: &Value) -> PathSet {
    let Some(obj) = json.as_object() else {
        return PathSet::None;
    };
    let mut paths = Vec::new();
    for key in ["path", "from_path", "to_path"] {
        if let Some(v) = obj.get(key) {
            match v.as_str() {
                Some(s) => paths.push(s.to_string()),
                None => return PathSet::Unparseable,
            }
        }
    }
    if let Some(entries) = obj.get("entries") {
        let Some(arr) = entries.as_array() else {
            return PathSet::Unparseable;
        };
        for entry in arr {
            let Some(eo) = entry.as_object() else {
                return PathSet::Unparseable;
            };
            let mut found = false;
            for key in ["path", "from_path", "to_path"] {
                if let Some(v) = eo.get(key) {
                    match v.as_str() {
                        Some(s) => {
                            paths.push(s.to_string());
                            found = true;
                        }
                        None => return PathSet::Unparseable,
                    }
                }
            }
            if !found {
                // A batch entry we cannot extract a path from — fail closed.
                return PathSet::Unparseable;
            }
        }
    }
    if paths.is_empty() {
        PathSet::None
    } else if paths.iter().any(|p| has_traversal(p)) {
        // A Dropbox path carrying a `.`/`..` segment cannot be confined by the
        // segment-prefix match (`/proj/../evil` prefix-matches `/proj` yet may
        // resolve elsewhere), so fail closed.
        PathSet::Unparseable
    } else {
        PathSet::Paths(paths)
    }
}

/// A request folder is in scope iff it equals, or is a descendant of, some
/// allowed folder. Dropbox paths are case-insensitive and `/`-delimited; the
/// prefix match is on whole segments (`/foo` allows `/foo` and `/foo/bar` but
/// not `/foobar`). An allowed entry that normalizes to the root ("") allows
/// everything.
fn folder_in_scope(req: &str, allowed: &[String]) -> bool {
    let req = norm_folder(req);
    allowed.iter().any(|a| {
        let a = norm_folder(a);
        a.is_empty() || req == a || req.starts_with(&format!("{a}/"))
    })
}

fn norm_folder(p: &str) -> String {
    p.trim_end_matches('/').to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::test_support::body_input;
    use super::super::{evaluate_scope, ScopeVerdict};
    use crate::policy::MatchInput;

    fn headers(pairs: &[(&str, &str)]) -> hyper::HeaderMap {
        let mut map = hyper::HeaderMap::new();
        for (name, value) in pairs {
            map.append(
                hyper::header::HeaderName::from_bytes(name.as_bytes()).expect("header name"),
                hyper::header::HeaderValue::from_str(value).expect("header value"),
            );
        }
        map
    }

    fn dbx_rpc(body: &[u8], allowed: &[&str]) -> ScopeVerdict {
        let scope = json!({ "folders": allowed });
        evaluate_scope(
            "dropbox",
            "api.dropboxapi.com",
            Some(&scope),
            "/2/files/list_folder",
            &body_input(body),
        )
    }

    #[test]
    fn dropbox_path_with_dot_segment_fails_closed() {
        // `/proj/../evil` prefix-matches `/proj` but resolves elsewhere.
        assert_eq!(
            dbx_rpc(br#"{"path":"/proj/../evil"}"#, &["/proj"]),
            ScopeVerdict::Indeterminate
        );
    }

    #[test]
    fn dropbox_rpc_in_and_out_of_scope() {
        assert_eq!(
            dbx_rpc(br#"{"path":"/proj/sub"}"#, &["/proj"]),
            ScopeVerdict::InScope
        );
        assert_eq!(
            dbx_rpc(br#"{"path":"/proj/sub"}"#, &["/other"]),
            ScopeVerdict::OutOfScope
        );
        // Segment boundary: /projX is not under /proj.
        assert_eq!(
            dbx_rpc(br#"{"path":"/projX"}"#, &["/proj"]),
            ScopeVerdict::OutOfScope
        );
    }

    #[test]
    fn dropbox_move_checks_all_path_fields() {
        assert_eq!(
            dbx_rpc(
                br#"{"from_path":"/proj/a","to_path":"/other/b"}"#,
                &["/proj"]
            ),
            ScopeVerdict::OutOfScope
        );
        assert_eq!(
            dbx_rpc(
                br#"{"from_path":"/proj/a","to_path":"/proj/b"}"#,
                &["/proj"]
            ),
            ScopeVerdict::InScope
        );
    }

    #[test]
    fn dropbox_batch_entries_are_checked() {
        assert_eq!(
            dbx_rpc(
                br#"{"entries":[{"from_path":"/proj/a","to_path":"/proj/b"}]}"#,
                &["/proj"]
            ),
            ScopeVerdict::InScope
        );
        assert_eq!(
            dbx_rpc(
                br#"{"entries":[{"from_path":"/proj/a","to_path":"/evil/b"}]}"#,
                &["/proj"]
            ),
            ScopeVerdict::OutOfScope
        );
        // An entry with no extractable path is fail-closed.
        assert_eq!(
            dbx_rpc(br#"{"entries":[{"cursor":"x"}]}"#, &["/proj"]),
            ScopeVerdict::Indeterminate
        );
    }

    #[test]
    fn dropbox_content_host_reads_the_header() {
        let scope = json!({ "folders": ["/proj"] });
        let input = MatchInput {
            body: None,
            body_truncated: false,
            headers: Some(&headers(&[(
                "dropbox-api-arg",
                r#"{"path":"/proj/f.txt"}"#,
            )])),
        };
        assert_eq!(
            evaluate_scope(
                "dropbox",
                "content.dropboxapi.com",
                Some(&scope),
                "/2/files/download",
                &input
            ),
            ScopeVerdict::InScope
        );
    }

    #[test]
    fn dropbox_content_host_out_of_scope_and_missing_header() {
        let scope = json!({ "folders": ["/proj"] });
        // Out of scope.
        let hit = MatchInput {
            body: None,
            body_truncated: false,
            headers: Some(&headers(&[(
                "dropbox-api-arg",
                r#"{"path":"/evil/f.txt"}"#,
            )])),
        };
        assert_eq!(
            evaluate_scope(
                "dropbox",
                "content.dropboxapi.com",
                Some(&scope),
                "/2/files/download",
                &hit
            ),
            ScopeVerdict::OutOfScope
        );
        // No header at all while scoped → fail closed.
        let miss = MatchInput {
            body: None,
            body_truncated: false,
            headers: Some(&headers(&[])),
        };
        assert_eq!(
            evaluate_scope(
                "dropbox",
                "content.dropboxapi.com",
                Some(&scope),
                "/2/files/download",
                &miss
            ),
            ScopeVerdict::Indeterminate
        );
        // A content op whose arg names no path is fail-closed (every content op
        // addresses a resource).
        let no_path = MatchInput {
            body: None,
            body_truncated: false,
            headers: Some(&headers(&[("dropbox-api-arg", r#"{"query":"x"}"#)])),
        };
        assert_eq!(
            evaluate_scope(
                "dropbox",
                "content.dropboxapi.com",
                Some(&scope),
                "/2/files/download",
                &no_path
            ),
            ScopeVerdict::Indeterminate
        );
    }

    #[test]
    fn dropbox_truncated_and_unparseable_body_fail_closed() {
        let scope = json!({ "folders": ["/proj"] });
        let truncated = MatchInput {
            body: None,
            body_truncated: true,
            headers: None,
        };
        assert_eq!(
            evaluate_scope(
                "dropbox",
                "api.dropboxapi.com",
                Some(&scope),
                "/2/files/list_folder",
                &truncated
            ),
            ScopeVerdict::Indeterminate
        );
        assert_eq!(
            dbx_rpc(b"not json", &["/proj"]),
            ScopeVerdict::Indeterminate
        );
        // Absent (unbuffered) body while scoped → fail closed.
        let absent = MatchInput::empty();
        assert_eq!(
            evaluate_scope(
                "dropbox",
                "api.dropboxapi.com",
                Some(&scope),
                "/2/files/list_folder",
                &absent
            ),
            ScopeVerdict::Indeterminate
        );
    }

    /// Evaluate a Dropbox RPC body against `/proj` at an arbitrary endpoint path.
    fn dbx_rpc_at(path: &str, body: &[u8]) -> ScopeVerdict {
        let scope = json!({ "folders": ["/proj"] });
        evaluate_scope(
            "dropbox",
            "api.dropboxapi.com",
            Some(&scope),
            path,
            &body_input(body),
        )
    }

    #[test]
    fn dropbox_account_endpoint_is_in_scope() {
        // `/2/users/get_current_account` sends a `null` body — no folder.
        assert_eq!(
            dbx_rpc_at("/2/users/get_current_account", b"null"),
            ScopeVerdict::InScope
        );
        // A no-arg (empty) body on an account endpoint is likewise in scope.
        assert_eq!(
            dbx_rpc_at("/2/users/get_current_account", b""),
            ScopeVerdict::InScope
        );
        assert_eq!(
            dbx_rpc_at("/2/users/get_space_usage", b"null"),
            ScopeVerdict::InScope
        );
        // Cursor-pagination `*/continue` inherits the original listing's scope.
        assert_eq!(
            dbx_rpc_at("/2/files/list_folder/continue", br#"{"cursor":"x"}"#),
            ScopeVerdict::InScope
        );
    }

    #[test]
    fn dropbox_path_less_body_on_a_resource_rpc_fails_closed() {
        // A path-less body (or an empty/null body) on any endpoint NOT on the
        // non-resource allowlist may address a resource through a field we do
        // not parse, so it is fail-closed rather than allowed.
        assert_eq!(
            dbx_rpc_at("/2/files/list_folder", b"null"),
            ScopeVerdict::Indeterminate
        );
        assert_eq!(
            dbx_rpc_at("/2/files/list_folder", b""),
            ScopeVerdict::Indeterminate
        );
        // Addressed by shared_folder_id — unconfinable at this layer → deny.
        assert_eq!(
            dbx_rpc_at(
                "/2/sharing/list_folder_members",
                br#"{"shared_folder_id":"123"}"#
            ),
            ScopeVerdict::Indeterminate
        );
        // A nested `options.path` we don't parse must not slip through.
        assert_eq!(
            dbx_rpc_at(
                "/2/files/search_v2",
                br#"{"query":"x","options":{"path":"/secret"}}"#
            ),
            ScopeVerdict::Indeterminate
        );
    }

    #[test]
    fn dropbox_root_path_escapes_a_folder_scope() {
        // list_folder on the whole Dropbox ("") is broader than any folder.
        assert_eq!(
            dbx_rpc(br#"{"path":""}"#, &["/proj"]),
            ScopeVerdict::OutOfScope
        );
    }
}
