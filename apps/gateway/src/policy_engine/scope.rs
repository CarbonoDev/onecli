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
//!
//! ## Layout
//!
//! This file is the entry point: the `pub(crate)` surface
//! ([`apply_resource_scope`], [`needs_body`]), the verdict type, and the
//! provider dispatch. The parts sit beside it:
//!
//! - [`session_policy`] — stored-value parsing (`{repositories}` / `{folders}`).
//! - [`path_safety`] — dot-segment rejection, shared by both extractors.
//! - [`github`] — the repository extractor + exact matcher.
//! - [`dropbox`] — the folder extractor + nesting matcher.

mod dropbox;
mod github;
mod path_safety;
mod session_policy;
#[cfg(test)]
mod test_support;

use serde_json::Value;

use self::dropbox::dropbox_scope;
use self::github::github_scope;
use self::session_policy::{parse, ResourceScope};
use crate::gateway::strip_port;
use crate::policy::{MatchInput, PolicyDecision};

/// The per-request scope verdict. `Indeterminate` is the fail-closed arm: a
/// scope is set but the resource cannot be determined.
#[derive(Debug, PartialEq, Eq)]
enum ScopeVerdict {
    InScope,
    OutOfScope,
    Indeterminate,
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::test_support::body_input;
    use super::*;

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
