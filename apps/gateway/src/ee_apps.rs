//! Cloud app providers (OSS stub — returns an empty slice).

use crate::apps::AppProvider;

/// Returns cloud app provider definitions (supplied by the EE builds).
pub(crate) fn providers() -> &'static [AppProvider] {
    &[]
}

/// Attempt to refresh credentials for an EE-managed cloud-app credential type.
/// Returns `None` if the credential type is not recognized (falls through to standard refresh).
pub(crate) async fn try_refresh_credentials(
    _cred_type: &str,
    _creds: &serde_json::Value,
    _session_policy: Option<&serde_json::Value>,
) -> Option<anyhow::Result<(String, i64)>> {
    None
}

/// Narrow a connection's selected scope to the organization's boundary. OSS
/// stores no boundaries, so the selection stands unchanged.
pub(crate) fn compose_resource_scope(
    _boundary: Option<&serde_json::Value>,
    selected: Option<&serde_json::Value>,
) -> Option<serde_json::Value> {
    selected.cloned()
}

/// Whether a resource scope reaches NOTHING. OSS stores no scopes.
pub(crate) fn scope_reaches_nothing(_policy: Option<&serde_json::Value>) -> bool {
    false
}

/// Whether this provider enforces a resource scope per REQUEST.
///
/// This fork DOES guard at the request layer, which is the whole of its
/// granular-resource-scoping model: rather than minting a credential narrowed
/// to the allowed repos/folders, it injects the ordinary credential and blocks
/// any request that addresses a resource outside the scope
/// (`policy_engine::scope::evaluate_scope`, applied by `apply_resource_scope`
/// after the policy decision and before injection).
///
/// Returning `false` here is NOT a safe default for this fork. `connect.rs`'s
/// fail-closed check withholds the credential entirely when a connection has a
/// session policy and neither a token scoper nor a request guard exists — and
/// since `try_refresh_credentials` is a stub, every resource-scoped GitHub or
/// Dropbox connection would silently stop injecting anything, with the whole
/// test suite still green.
///
/// The list mirrors `evaluate_scope`'s dispatch exactly: any provider not named
/// there falls through to `Indeterminate` and is blocked anyway, so claiming a
/// guard for one would be claiming an enforcement that does not exist.
pub(crate) fn has_request_guard(provider: &str) -> bool {
    matches!(provider, "github-app" | "github" | "dropbox")
}

/// Whether this credential type mints a RESOURCE-SCOPED credential from the
/// provider (e.g. a GitHub installation token limited to specific repos).
/// Such a credential is minted live per request and never persisted, so the
/// caller defers it until the request is known to be allowed. OSS scopes no
/// credentials, so it never defers.
pub(crate) fn has_token_scoper(_cred_type: &str) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    // The regression guard for the fail-closed check in
    // `connect.rs::resolve_access_token`. That check withholds the credential
    // when a connection carries a session policy and neither a token scoper nor
    // a request guard exists. `try_refresh_credentials` is a stub here, so
    // `has_request_guard` is the ONLY thing keeping resource-scoped connections
    // working — if it ever returns false for these providers, every scoped
    // GitHub/Dropbox connection silently stops injecting, and nothing else in
    // the suite notices (scope.rs's tests never reach resolve_access_token).
    #[test]
    fn request_guard_covers_every_provider_evaluate_scope_dispatches_on() {
        for provider in ["github-app", "github", "dropbox"] {
            assert!(
                has_request_guard(provider),
                "{provider} is enforced at the request layer by \
                 policy_engine::scope::evaluate_scope — claiming no guard here \
                 makes connect.rs withhold its credential entirely"
            );
        }
    }

    #[test]
    fn request_guard_is_not_claimed_for_unguarded_providers() {
        // evaluate_scope falls through to Indeterminate -> Blocked for these,
        // so claiming a guard would assert an enforcement that does not exist.
        for provider in ["slack", "notion", "aws-role", ""] {
            assert!(!has_request_guard(provider));
        }
    }
}
