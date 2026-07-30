//! Granular resource-scope enforcement (Tier 3b).
//!
//! A connection may carry a per-agent *granular session policy* that confines
//! the injected credential to specific resources — a GitHub connection limited
//! to certain repositories, a Dropbox connection limited to certain folders.
//! The API validates and stores it (`agent_app_connections.session_policy`,
//! the `sessionPolicySchema` union `{repositories:[…]}` | `{folders:[…]}`) and
//! the gateway resolves it once per request into
//! `ResolvedRules.session_policy`. This module is the enforcement the OSS build
//! previously lacked: it parses that value and, per provider, extracts the
//! resource a request addresses, then TIGHTENS the already-computed policy
//! decision — an allow-family verdict for an out-of-scope or indeterminate
//! resource becomes `Blocked`; an existing block is returned untouched. It is a
//! monotone tightening (`final = max(engine_verdict, scope_verdict)`, Block the
//! strictest), so it composes with the first-match / stricter-wins engine law
//! and can never widen what the rules closed.
//!
//! ## Provider coverage
//!
//! Exactly the two providers the DB/API/UI model:
//!
//! - **GitHub** (`github-app`, `github`): `{repositories:["owner/repo", …]}`.
//!   The repo is read from the URL path — `/repos/{owner}/{repo}` on
//!   `api.github.com`, `/{owner}/{repo}(.git)?/…` for git-over-HTTPS and raw
//!   content on any other GitHub host. Case-insensitive (GitHub repo names are).
//! - **Dropbox** (`dropbox`): `{folders:["/path", …]}`. The folder is read from
//!   the request JSON — the buffered body on `api.dropboxapi.com` RPC endpoints,
//!   the `Dropbox-API-Arg` header on `content.dropboxapi.com`. A request is in
//!   scope iff every path it names is equal to, or a descendant of, an allowed
//!   folder (segment-boundary prefix match; case-insensitive).
//!
//! Every other provider, GitHub GraphQL / numeric `/repositories/{id}`, and any
//! resource axis other than repositories/folders are **not** covered — they hit
//! the fail-closed indeterminate arm below. The web `granularAccessConfigs`
//! register the same two providers, so there is no authoring surface for an
//! axis this build cannot extract.
//!
//! ## Fail-closed (SECURITY)
//!
//! When a scope is set and the requested resource cannot be positively verified
//! in scope, the request is DENIED. Indeterminate covers: an unparseable /
//! numeric / GraphQL GitHub repo reference; a missing, unparseable, absent, or
//! truncated Dropbox arg; a malformed session-policy object (unknown key / wrong
//! value types); a scope whose shape does not match its provider; and any
//! provider this build does not understand while a scope is present. The *only*
//! allow paths are: no scope at all (`parse → None`, the gate is a no-op — the
//! overwhelmingly common case), a positively verified in-scope resource, or an
//! endpoint positively classified as not resource-addressed (GitHub
//! account/search/meta endpoints; Dropbox RPC account endpoints).

use serde_json::Value;

use crate::gateway::strip_port;
use crate::policy::{MatchInput, PolicyDecision};

/// A parsed granular session policy. `Malformed` marks a scope that is present
/// but garbled (unknown key, non-string list, both keys, extra keys); it maps
/// to `Indeterminate` at evaluation so a garbled scope never reads as "all".
#[derive(Debug, PartialEq, Eq)]
enum ResourceScope {
    Repositories(Vec<String>),
    Folders(Vec<String>),
    Malformed,
}

/// The per-request scope verdict. `Indeterminate` is the fail-closed arm: a
/// scope is set but the resource cannot be determined.
#[derive(Debug, PartialEq, Eq)]
enum ScopeVerdict {
    InScope,
    OutOfScope,
    Indeterminate,
}

/// Parse a stored `session_policy` value into a scope, mirroring the API
/// `sessionPolicySchema`. Returns `None` for "no scope" — an empty/absent
/// object, an empty `repositories`/`folders` list, `null`, or any non-object
/// (all mean "all resources", so the gate is a no-op). Returns
/// `Some(Malformed)` for a scope-present-but-garbled object.
fn parse(sp: &Value) -> Option<ResourceScope> {
    let obj = sp.as_object()?; // non-object → unscoped
    if obj.is_empty() {
        return None; // {} → all
    }
    let has_repos = obj.contains_key("repositories");
    let has_folders = obj.contains_key("folders");
    match (has_repos, has_folders, obj.len()) {
        // Exactly one recognized key, nothing else — the strict union shape.
        (true, false, 1) => Some(match string_list(&obj["repositories"]) {
            ListShape::Values(v) => ResourceScope::Repositories(v),
            ListShape::Empty => return None, // empty list = all
            ListShape::Malformed => ResourceScope::Malformed,
        }),
        (false, true, 1) => Some(match string_list(&obj["folders"]) {
            ListShape::Values(v) => ResourceScope::Folders(v),
            ListShape::Empty => return None,
            ListShape::Malformed => ResourceScope::Malformed,
        }),
        // Unknown key, both keys, or extra keys alongside a recognized one.
        _ => Some(ResourceScope::Malformed),
    }
}

enum ListShape {
    Values(Vec<String>),
    Empty,
    Malformed,
}

/// A JSON value must be an array of strings. A non-array, or any non-string
/// element, is malformed (fail-closed); an empty array is "all".
fn string_list(v: &Value) -> ListShape {
    let Some(arr) = v.as_array() else {
        return ListShape::Malformed;
    };
    if arr.is_empty() {
        return ListShape::Empty;
    }
    let mut out = Vec::with_capacity(arr.len());
    for el in arr {
        match el.as_str() {
            Some(s) => out.push(s.to_string()),
            None => return ListShape::Malformed,
        }
    }
    ListShape::Values(out)
}

/// Whether the request body must be buffered for scope extraction. True only
/// for a `dropbox` connection with a non-empty `{folders}` policy on the RPC
/// host `api.dropboxapi.com` (the folder rides in the JSON body). GitHub is
/// URL-only and `content.dropboxapi.com` reads the `Dropbox-API-Arg` header, so
/// neither buffers — critically, the content host must NOT buffer, its body is
/// the uploaded/downloaded file, not the folder argument.
pub(crate) fn needs_body(provider: &str, host: &str, session_policy: Option<&Value>) -> bool {
    provider == "dropbox"
        && strip_port(host) == "api.dropboxapi.com"
        && matches!(
            session_policy.and_then(parse),
            Some(ResourceScope::Folders(_))
        )
}

/// Tighten an already-computed policy decision by the connection's granular
/// resource scope. An existing Block (rule or default) is returned untouched —
/// scope never re-attributes or loosens a denial. Otherwise an out-of-scope or
/// indeterminate resource maps the allow-family verdict (Allow / ManualApproval
/// / RateLimited) to `Blocked { rule_name: "resource scope" }`. The returned
/// bool is `scope_blocked`, so the caller can drop rule attribution (the block
/// is scope-authored, not rule-authored).
pub(crate) fn apply_resource_scope(
    decision: PolicyDecision,
    provider: &str,
    host: &str,
    session_policy: Option<&Value>,
    path: &str,
    input: &MatchInput<'_>,
) -> (PolicyDecision, bool) {
    // Already denied → never loosen, never re-attribute.
    if matches!(
        decision,
        PolicyDecision::Blocked { .. } | PolicyDecision::BlockedByDefaultPolicy
    ) {
        return (decision, false);
    }
    match evaluate_scope(provider, host, session_policy, path, input) {
        ScopeVerdict::InScope => (decision, false),
        ScopeVerdict::OutOfScope | ScopeVerdict::Indeterminate => (
            PolicyDecision::Blocked {
                rule_name: "resource scope".to_string(),
            },
            true,
        ),
    }
}

/// The pure verdict: does this request address a resource the scope allows? No
/// scope present → `InScope` (the gate is a no-op). Dispatch is by provider AND
/// validates the scope shape matches (github ⇒ Repositories, dropbox ⇒ Folders);
/// any mismatch, a `Malformed` scope, or an unknown provider carrying a scope →
/// `Indeterminate` (a scope authored for an axis this build cannot extract must
/// never pass).
fn evaluate_scope(
    provider: &str,
    host: &str,
    session_policy: Option<&Value>,
    path: &str,
    input: &MatchInput<'_>,
) -> ScopeVerdict {
    let scope = match session_policy.and_then(parse) {
        None => return ScopeVerdict::InScope, // unscoped → no-op
        Some(s) => s,
    };
    match (provider, scope) {
        ("github-app" | "github", ResourceScope::Repositories(allowed)) => {
            github_scope(strip_port(host), path, &allowed)
        }
        ("dropbox", ResourceScope::Folders(allowed)) => dropbox_scope(host, path, input, &allowed),
        _ => ScopeVerdict::Indeterminate,
    }
}

// ── Path traversal (SECURITY) ───────────────────────────────────────────────

/// Whether a single `/`-delimited segment is a `.`/`..` dot-segment, including
/// its percent-encoded forms (`%2e`, `%2E`, `%2e%2e`, …). Decoded lossily so a
/// non-UTF-8 segment simply fails to match rather than panicking.
fn is_dot_segment(seg: &str) -> bool {
    let decoded = percent_encoding::percent_decode_str(seg).decode_utf8_lossy();
    decoded == "." || decoded == ".."
}

/// Whether a path contains any dot-segment. The forwarding layer builds the
/// upstream URL with the `url` crate, which collapses `.`/`..` (and their
/// `%2e` encodings) per WHATWG *before* the request is sent, so a scope check
/// run on the RAW request path would extract a resource from a path GitHub
/// never sees. Any such path is therefore treated as unverifiable (fail closed)
/// rather than parsed at face value.
fn has_traversal(path: &str) -> bool {
    path.split('/').any(is_dot_segment)
}

// ── GitHub ────────────────────────────────────────────────────────────────

/// What repository, if any, a GitHub request path addresses.
enum RepoRef {
    /// `owner`, `repo` (repo case-folded at compare time).
    Repo(String, String),
    /// Account/search/meta endpoint — cannot name an out-of-scope repo.
    NotRepoAddressed,
    /// Repo-addressed but unverifiable at the URL layer (numeric id, GraphQL,
    /// a `/repos/` prefix we cannot split) — fail closed.
    Indeterminate,
}

fn github_scope(host: &str, path: &str, allowed: &[String]) -> ScopeVerdict {
    match github_repo_ref(host, path) {
        RepoRef::Repo(owner, repo) => {
            if repo_in_scope(&owner, &repo, allowed) {
                ScopeVerdict::InScope
            } else {
                ScopeVerdict::OutOfScope
            }
        }
        RepoRef::NotRepoAddressed => ScopeVerdict::InScope,
        RepoRef::Indeterminate => ScopeVerdict::Indeterminate,
    }
}

fn github_repo_ref(host: &str, path: &str) -> RepoRef {
    // Drop query / fragment before splitting.
    let path = path.split(['?', '#']).next().unwrap_or(path);
    // A dot-segment (`.`/`..`, raw or `%2e`-encoded) is collapsed by the
    // forwarding layer's URL builder before the request reaches GitHub, so the
    // repo we would extract here is not the repo that gets served. Fail closed.
    if has_traversal(path) {
        return RepoRef::Indeterminate;
    }
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();

    if host == "api.github.com" {
        match segs.first().copied() {
            Some("repos") => match (segs.get(1), segs.get(2)) {
                (Some(owner), Some(repo)) if !owner.is_empty() && !repo.is_empty() => {
                    RepoRef::Repo((*owner).to_string(), (*repo).to_string())
                }
                // `/repos` or `/repos/{owner}` — repo-prefixed, no repo named.
                _ => RepoRef::Indeterminate,
            },
            // Numeric legacy id and GraphQL name the repo somewhere we can't
            // confine at the URL layer.
            Some("repositories") => RepoRef::Indeterminate,
            Some("graphql") => RepoRef::Indeterminate,
            // Everything else (`/user*`, `/orgs*`, `/search*`, `/rate_limit`,
            // `/installation/repositories`, `/meta`, root, …) cannot name an
            // out-of-scope repo (enumeration is bounded by GitHub's repo-scoped
            // installation token server-side).
            _ => RepoRef::NotRepoAddressed,
        }
    } else {
        // git-over-HTTPS (`github.com`) and raw content
        // (`raw.githubusercontent.com`): `/{owner}/{repo}(.git)?/…`.
        match (segs.first(), segs.get(1)) {
            (Some(owner), Some(repo)) if !owner.is_empty() && !repo.is_empty() => {
                let repo = repo.strip_suffix(".git").unwrap_or(repo);
                if repo.is_empty() {
                    RepoRef::Indeterminate
                } else {
                    RepoRef::Repo((*owner).to_string(), repo.to_string())
                }
            }
            // Fewer than two segments (root, `/settings`, …) → not a repo path.
            _ => RepoRef::NotRepoAddressed,
        }
    }
}

fn repo_in_scope(owner: &str, repo: &str, allowed: &[String]) -> bool {
    let target = format!(
        "{}/{}",
        owner.to_ascii_lowercase(),
        repo.to_ascii_lowercase()
    );
    allowed.iter().any(|a| a.to_ascii_lowercase() == target)
}

// ── Dropbox ─────────────────────────────────────────────────────────────────

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

fn dropbox_scope(
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

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

    /// A `MatchInput` carrying only a buffered body.
    fn body_input(body: &[u8]) -> MatchInput<'_> {
        MatchInput {
            body: Some(body),
            body_truncated: false,
            headers: None,
        }
    }

    // ── parse ────────────────────────────────────────────────────────────

    #[test]
    fn parse_recognizes_the_two_shapes() {
        assert_eq!(
            parse(&json!({"repositories": ["a/b"]})),
            Some(ResourceScope::Repositories(vec!["a/b".to_string()]))
        );
        assert_eq!(
            parse(&json!({"folders": ["/x"]})),
            Some(ResourceScope::Folders(vec!["/x".to_string()]))
        );
    }

    #[test]
    fn parse_treats_empty_and_absent_as_unscoped() {
        assert_eq!(parse(&json!({})), None);
        assert_eq!(parse(&json!({"repositories": []})), None);
        assert_eq!(parse(&json!({"folders": []})), None);
        assert_eq!(parse(&Value::Null), None);
        assert_eq!(parse(&json!(["a/b"])), None); // top-level array
        assert_eq!(parse(&json!("str")), None); // non-object
    }

    #[test]
    fn parse_flags_garbled_objects_as_malformed() {
        assert_eq!(
            parse(&json!({"unknownKey": ["x"]})),
            Some(ResourceScope::Malformed)
        );
        // Extra key alongside a recognized one.
        assert_eq!(
            parse(&json!({"repositories": ["a/b"], "folders": ["/x"]})),
            Some(ResourceScope::Malformed)
        );
        // Non-string list element.
        assert_eq!(
            parse(&json!({"repositories": [1, 2]})),
            Some(ResourceScope::Malformed)
        );
        // Value is not a list.
        assert_eq!(
            parse(&json!({"folders": "/x"})),
            Some(ResourceScope::Malformed)
        );
    }

    // ── GitHub extraction ────────────────────────────────────────────────

    fn gh(host: &str, path: &str, allowed: &[&str]) -> ScopeVerdict {
        let scope = json!({ "repositories": allowed });
        evaluate_scope("github-app", host, Some(&scope), path, &MatchInput::empty())
    }

    #[test]
    fn github_in_and_out_of_scope_by_repo() {
        assert_eq!(
            gh("api.github.com", "/repos/acme/app/pulls", &["acme/app"]),
            ScopeVerdict::InScope
        );
        assert_eq!(
            gh("api.github.com", "/repos/acme/app/pulls", &["acme/other"]),
            ScopeVerdict::OutOfScope
        );
    }

    #[test]
    fn github_is_case_insensitive() {
        assert_eq!(
            gh("api.github.com", "/repos/ACME/App", &["acme/app"]),
            ScopeVerdict::InScope
        );
    }

    #[test]
    fn github_git_over_https_path() {
        assert_eq!(
            gh("github.com", "/acme/app.git/info/refs", &["acme/app"]),
            ScopeVerdict::InScope
        );
        assert_eq!(
            gh("github.com", "/acme/app.git/info/refs", &["acme/other"]),
            ScopeVerdict::OutOfScope
        );
    }

    #[test]
    fn github_raw_content_host_is_repo_addressed() {
        assert_eq!(
            gh(
                "raw.githubusercontent.com",
                "/acme/app/main/README.md",
                &["acme/app"]
            ),
            ScopeVerdict::InScope
        );
        assert_eq!(
            gh(
                "raw.githubusercontent.com",
                "/acme/secret/main/x",
                &["acme/app"]
            ),
            ScopeVerdict::OutOfScope
        );
    }

    #[test]
    fn github_account_endpoints_are_in_scope() {
        for path in [
            "/user/repos",
            "/orgs/acme/repos",
            "/rate_limit",
            "/",
            "/meta",
        ] {
            assert_eq!(
                gh("api.github.com", path, &["acme/app"]),
                ScopeVerdict::InScope,
                "account endpoint {path} must not be repo-scoped"
            );
        }
    }

    #[test]
    fn github_unverifiable_repo_references_are_indeterminate() {
        assert_eq!(
            gh("api.github.com", "/repositories/12345", &["acme/app"]),
            ScopeVerdict::Indeterminate
        );
        assert_eq!(
            gh("api.github.com", "/graphql", &["acme/app"]),
            ScopeVerdict::Indeterminate
        );
        // `/repos/` prefix with no repo named.
        assert_eq!(
            gh("api.github.com", "/repos/acme", &["acme/app"]),
            ScopeVerdict::Indeterminate
        );
    }

    #[test]
    fn github_dot_segment_traversal_fails_closed() {
        // The forwarding layer's URL builder collapses `..` before the request
        // reaches GitHub, so a raw path that prefixes an in-scope repo but
        // traverses out of it must NOT read as in scope. Both API and git hosts.
        assert_eq!(
            gh(
                "api.github.com",
                "/repos/acme/app/../../evil/target/contents/secret",
                &["acme/app"]
            ),
            ScopeVerdict::Indeterminate
        );
        // Percent-encoded dot-segments are collapsed identically.
        assert_eq!(
            gh(
                "api.github.com",
                "/repos/acme/app/%2e%2e/%2e%2e/evil/repo",
                &["acme/app"]
            ),
            ScopeVerdict::Indeterminate
        );
        assert_eq!(
            gh(
                "github.com",
                "/acme/app/../../evil/repo.git/info/refs",
                &["acme/app"]
            ),
            ScopeVerdict::Indeterminate
        );
    }

    #[test]
    fn dropbox_path_with_dot_segment_fails_closed() {
        // `/proj/../evil` prefix-matches `/proj` but resolves elsewhere.
        assert_eq!(
            dbx_rpc(br#"{"path":"/proj/../evil"}"#, &["/proj"]),
            ScopeVerdict::Indeterminate
        );
    }

    // ── Dropbox extraction ───────────────────────────────────────────────

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

    // ── No scope + unknown provider / shape mismatch ─────────────────────

    #[test]
    fn no_scope_is_always_in_scope() {
        for provider in ["github-app", "dropbox", "slack"] {
            assert_eq!(
                evaluate_scope(
                    provider,
                    "api.example.com",
                    None,
                    "/anything",
                    &MatchInput::empty()
                ),
                ScopeVerdict::InScope
            );
            // An empty object is "all" → still a no-op.
            assert_eq!(
                evaluate_scope(
                    provider,
                    "api.example.com",
                    Some(&json!({})),
                    "/anything",
                    &MatchInput::empty()
                ),
                ScopeVerdict::InScope
            );
        }
    }

    #[test]
    fn unknown_provider_with_a_scope_is_indeterminate() {
        let scope = json!({ "repositories": ["acme/app"] });
        assert_eq!(
            evaluate_scope(
                "slack",
                "slack.com",
                Some(&scope),
                "/api/x",
                &MatchInput::empty()
            ),
            ScopeVerdict::Indeterminate
        );
    }

    #[test]
    fn shape_mismatch_is_indeterminate() {
        // GitHub provider carrying a folders scope, or vice versa.
        let folders = json!({ "folders": ["/x"] });
        assert_eq!(
            evaluate_scope(
                "github-app",
                "api.github.com",
                Some(&folders),
                "/repos/a/b",
                &MatchInput::empty()
            ),
            ScopeVerdict::Indeterminate
        );
        let repos = json!({ "repositories": ["a/b"] });
        assert_eq!(
            evaluate_scope(
                "dropbox",
                "api.dropboxapi.com",
                Some(&repos),
                "/2/files/list_folder",
                &body_input(b"{}")
            ),
            ScopeVerdict::Indeterminate
        );
    }

    #[test]
    fn malformed_scope_is_indeterminate() {
        let malformed = json!({ "unknownKey": ["x"] });
        assert_eq!(
            evaluate_scope(
                "github-app",
                "api.github.com",
                Some(&malformed),
                "/repos/a/b",
                &MatchInput::empty()
            ),
            ScopeVerdict::Indeterminate
        );
    }

    // ── needs_body ───────────────────────────────────────────────────────

    #[test]
    fn needs_body_only_for_dropbox_rpc_folders() {
        let folders = json!({ "folders": ["/x"] });
        let repos = json!({ "repositories": ["a/b"] });
        assert!(needs_body("dropbox", "api.dropboxapi.com", Some(&folders)));
        assert!(needs_body(
            "dropbox",
            "api.dropboxapi.com:443",
            Some(&folders)
        ));
        // Content host reads the header, never the body.
        assert!(!needs_body(
            "dropbox",
            "content.dropboxapi.com",
            Some(&folders)
        ));
        // GitHub is URL-only.
        assert!(!needs_body("github-app", "api.github.com", Some(&repos)));
        // No scope → no buffering.
        assert!(!needs_body("dropbox", "api.dropboxapi.com", None));
        assert!(!needs_body(
            "dropbox",
            "api.dropboxapi.com",
            Some(&json!({}))
        ));
    }

    // ── apply_resource_scope (the tightening gate) ───────────────────────

    fn out_of_scope_repo() -> Value {
        json!({ "repositories": ["acme/app"] })
    }

    #[test]
    fn gate_blocks_an_out_of_scope_allow() {
        let scope = out_of_scope_repo();
        let (decision, blocked) = apply_resource_scope(
            PolicyDecision::Allow,
            "github-app",
            "api.github.com",
            Some(&scope),
            "/repos/acme/secret/pulls",
            &MatchInput::empty(),
        );
        assert!(matches!(decision, PolicyDecision::Blocked { .. }));
        assert!(blocked);
    }

    #[test]
    fn gate_leaves_an_in_scope_allow_untouched() {
        let scope = out_of_scope_repo();
        let (decision, blocked) = apply_resource_scope(
            PolicyDecision::Allow,
            "github-app",
            "api.github.com",
            Some(&scope),
            "/repos/acme/app/pulls",
            &MatchInput::empty(),
        );
        assert!(matches!(decision, PolicyDecision::Allow));
        assert!(!blocked);
    }

    #[test]
    fn gate_returns_an_existing_block_untouched() {
        // Already denied: never re-attributed, never a scope block.
        let (decision, blocked) = apply_resource_scope(
            PolicyDecision::Blocked {
                rule_name: "some rule".to_string(),
            },
            "github-app",
            "api.github.com",
            Some(&out_of_scope_repo()),
            "/repos/acme/secret/pulls",
            &MatchInput::empty(),
        );
        match decision {
            PolicyDecision::Blocked { rule_name } => assert_eq!(rule_name, "some rule"),
            other => panic!("expected the original block, got {other:?}"),
        }
        assert!(!blocked);
        // Default-policy blocks are equally untouched.
        let (decision, blocked) = apply_resource_scope(
            PolicyDecision::BlockedByDefaultPolicy,
            "github-app",
            "api.github.com",
            Some(&out_of_scope_repo()),
            "/repos/acme/secret/pulls",
            &MatchInput::empty(),
        );
        assert!(matches!(decision, PolicyDecision::BlockedByDefaultPolicy));
        assert!(!blocked);
    }

    #[test]
    fn gate_tightens_manual_approval_and_rate_limit_out_of_scope() {
        // The tightening beats an approval / rate-limit modifier (stricter-wins).
        let scope = out_of_scope_repo();
        let (decision, blocked) = apply_resource_scope(
            PolicyDecision::ManualApproval {
                rule_id: "r".to_string(),
            },
            "github-app",
            "api.github.com",
            Some(&scope),
            "/repos/acme/secret/pulls",
            &MatchInput::empty(),
        );
        assert!(matches!(decision, PolicyDecision::Blocked { .. }));
        assert!(blocked);

        let (decision, blocked) = apply_resource_scope(
            PolicyDecision::RateLimited {
                rule_name: "r".to_string(),
                limit: 1,
                window: "minute",
                retry_after_secs: 1,
            },
            "github-app",
            "api.github.com",
            Some(&scope),
            "/repos/acme/secret/pulls",
            &MatchInput::empty(),
        );
        assert!(matches!(decision, PolicyDecision::Blocked { .. }));
        assert!(blocked);
    }

    #[test]
    fn gate_is_a_noop_when_no_scope_is_set() {
        // The common case: an approval verdict with no scope passes through
        // unchanged so the approval flow still runs.
        let (decision, blocked) = apply_resource_scope(
            PolicyDecision::ManualApproval {
                rule_id: "r".to_string(),
            },
            "github-app",
            "api.github.com",
            None,
            "/repos/acme/secret/pulls",
            &MatchInput::empty(),
        );
        assert!(matches!(decision, PolicyDecision::ManualApproval { .. }));
        assert!(!blocked);
    }

    #[test]
    fn gate_indeterminate_out_of_scope_provider_blocks_an_allow() {
        // A scope for a provider this build cannot extract must never pass.
        let scope = out_of_scope_repo();
        let (decision, blocked) = apply_resource_scope(
            PolicyDecision::Allow,
            "slack",
            "slack.com",
            Some(&scope),
            "/api/chat.postMessage",
            &MatchInput::empty(),
        );
        assert!(matches!(decision, PolicyDecision::Blocked { .. }));
        assert!(blocked);
    }
}
