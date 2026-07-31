//! Phase 5 (final phase of the remote-gateway hardening series): cert↔token
//! tenant binding. Where Phase 1-3 threaded an mTLS `ClientIdentity` onto
//! [`crate::gateway::ProxyContext`] and logged it, and Phase 2 minted
//! certificates carrying it, this module is the first to ever COMPARE it
//! against anything — a relay's client-certificate identity may only carry
//! agent tokens for its own tenant.
//!
//! Everything here is pure and DB-free: [`evaluate`] takes an
//! already-resolved [`crate::db::ClientHostRow`] lookup result and returns a
//! [`BindingDecision`]. The I/O (the cached DB lookup, and turning a `Deny`
//! into an actual HTTP response) lives in `gateway.rs`'s `enforce_binding`,
//! which is the ONLY caller of `evaluate` — so the CONNECT and HTTP-proxy
//! entry points can never drift from each other or from this decision table.
//!
//! # The binding rule
//!
//! A request is permitted iff the `ClientHost` resolved from the cert
//! identity's spiffe URI has `project_id == token.project_id`, is not
//! revoked, and — when it also carries an `organization_id` — that value
//! equals the token's `organization_id` too (a redundant consistency check;
//! project scoping alone is already sufficient, since a project belongs to
//! exactly one org). The `ClientHost` row IS the allowlist entry: no row for
//! this spiffe URI means no permission, full stop (deny-unless-permitted,
//! never a blocklist).
//!
//! # Modes
//!
//! `GATEWAY_BINDING_ENFORCEMENT` ([`BindingMode::from_env`]) defaults to
//! [`BindingMode::Off`] — unset, this module is a complete no-op and the
//! gateway behaves exactly as every prior phase left it. `Log` computes the
//! same decision as `Enforce` but never denies — a would-be deny becomes
//! [`BindingDecision::WouldDeny`], which the caller logs and then allows
//! anyway, so an operator can watch what enforcement WOULD do before
//! flipping the switch. `Enforce` denies for real.
//!
//! # The two subtleties this module (and its caller) must get right
//!
//! 1. Exemption is by LISTENER KIND (`on_mtls`), never by
//!    `client_identity.is_some()`. An mTLS handshake whose cert has an
//!    unparseable CN/SAN also yields no identity — and that case must be
//!    DENIED in enforce (nothing in the cert can satisfy the allowlist), not
//!    waved through as if it came in on the plain listener.
//! 2. The plain listener (web-app / loopback / all-in-one local-agent path,
//!    no cert involved at all) is exempt in EVERY mode — enforcing there
//!    would deny all of that traffic, which never had a certificate to bind
//!    in the first place.

use crate::db::ClientHostRow;

// ── Mode ──────────────────────────────────────────────────────────────────

/// Enforcement posture, read once at startup from `GATEWAY_BINDING_ENFORCEMENT`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BindingMode {
    /// No-op: `evaluate` is never even called (the caller short-circuits
    /// before doing so) — zero DB/cache overhead beyond a mode check.
    /// The default, so an unset var is byte-for-byte backward compatible.
    Off,
    /// Compute the real decision, but a would-be deny only logs — the
    /// request is still allowed. Lets an operator watch what `Enforce` would
    /// do before flipping to it.
    Log,
    /// Deny for real.
    Enforce,
}

impl BindingMode {
    /// Parse an already-read `GATEWAY_BINDING_ENFORCEMENT` value. No env
    /// access — this is the unit-testable core; [`Self::from_env`] is the
    /// thin wrapper that reads the var and forwards here (mirroring the
    /// `from_parts`/`from_env` split in `client_ca.rs`).
    ///
    /// Unrecognized text (including an explicitly-set empty string) is
    /// treated as `Off`, but — unlike a genuinely UNSET var — with a warning:
    /// an operator who set the var at all almost certainly meant something by
    /// it, and a silent fall-through to "disabled" on a typo would be exactly
    /// the kind of misconfiguration this feature exists to prevent going
    /// unnoticed.
    fn from_value(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "off" => BindingMode::Off,
            "log" => BindingMode::Log,
            "enforce" => BindingMode::Enforce,
            other => {
                tracing::warn!(
                    value = %other,
                    "GATEWAY_BINDING_ENFORCEMENT: unrecognized value, defaulting to off"
                );
                BindingMode::Off
            }
        }
    }

    /// Read `GATEWAY_BINDING_ENFORCEMENT` from the environment. Unset (the
    /// common case, and every deployment prior to Phase 5) resolves to `Off`
    /// with no warning at all — that is simply the default, not a
    /// misconfiguration.
    pub(crate) fn from_env() -> Self {
        match std::env::var("GATEWAY_BINDING_ENFORCEMENT") {
            Ok(value) => Self::from_value(&value),
            Err(_) => BindingMode::Off,
        }
    }
}

// ── Decision ─────────────────────────────────────────────────────────────

/// The reason string used when the host-tenant lookup itself failed (a DB or
/// cache error, as opposed to a permanent "no such host" / "wrong tenant"
/// verdict). `gateway.rs`'s `enforce_binding` matches on this exact value to
/// choose 502 (retryable) over 403 (permanent) — see its doc comment.
pub(crate) const REASON_HOST_LOOKUP_ERROR: &str = "host_lookup_error";

/// Outcome of [`evaluate`]. `Deny` and `WouldDeny` carry the same permanent,
/// human-readable reasons — the only difference is what the caller does with
/// them (deny the request vs. log-and-allow it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BindingDecision {
    /// Permitted — proceed.
    Allow,
    /// Denied for real (mode = `Enforce`).
    Deny { reason: &'static str },
    /// Would have been denied under `Enforce`, but mode = `Log`: the caller
    /// logs this and allows the request anyway.
    WouldDeny { reason: &'static str },
}

/// The pure decision core. No I/O: `host_tenant` is the ALREADY-RESOLVED
/// result of looking up the cert identity's spiffe URI against `client_hosts`
/// (`Err(())` for "the lookup itself failed", not "no matching row" — that's
/// `Ok(None)`).
///
/// Evaluated in this order:
/// 1. `mode == Off` → `Allow`, unconditionally — this module never even looks
///    at the other arguments in that case (the caller shouldn't either; see
///    `gateway.rs`'s `enforce_binding`, which skips the lookup entirely).
/// 2. `!on_mtls` → `Allow` — the plain listener is exempt BY LISTENER KIND in
///    every mode (subtlety #2 in the module doc). Checked before `identity`
///    so a plain-listener request is never denied no matter what (there is
///    no cert at all on that path).
/// 3. `identity.is_none()` (only reachable when `on_mtls` is true) → deny —
///    an mTLS handshake that verified but whose CN/SAN was unparseable has
///    nothing to satisfy the allowlist with (subtlety #1).
/// 4. `host_tenant` is `Err(())` (the lookup failed) → deny, fail-closed —
///    an outage must never silently become an allow.
/// 5. `host_tenant` is `Ok(None)` (no `client_hosts` row for this spiffe URI)
///    → deny — deny-unless-permitted; the row IS the allowlist entry.
/// 6. The row is revoked (`revoked_at.is_some()`) → deny.
/// 7. `row.project_id != token_project` → deny.
/// 8. The row carries a non-null `organization_id` that disagrees with
///    `token_org` → deny (the redundant consistency check).
/// 9. Otherwise → `Allow`.
///
/// In `Log` mode every deny reached via steps 3-8 becomes `WouldDeny`
/// instead of `Deny` — the caller allows the request and logs what would
/// have happened. `Enforce` returns `Deny` for the same steps.
pub(crate) fn evaluate(
    mode: BindingMode,
    on_mtls: bool,
    identity: Option<&str>,
    host_tenant: Result<Option<&ClientHostRow>, ()>,
    token_project: &str,
    token_org: Option<&str>,
) -> BindingDecision {
    if matches!(mode, BindingMode::Off) {
        return BindingDecision::Allow;
    }

    // Plain-listener requests are exempt BY LISTENER KIND, in every mode —
    // never inferred from `identity.is_none()` (see step 3 below, and the
    // module doc's subtlety #1).
    if !on_mtls {
        return BindingDecision::Allow;
    }

    // Local closure so every deny path below picks Deny-vs-WouldDeny the
    // same way, from one place — the mode check can never drift between them.
    let deny = |reason: &'static str| -> BindingDecision {
        if matches!(mode, BindingMode::Log) {
            BindingDecision::WouldDeny { reason }
        } else {
            BindingDecision::Deny { reason }
        }
    };

    let Some(_identity) = identity else {
        // An mTLS handshake with no extractable identity (unparseable CN/SAN)
        // can never satisfy the allowlist — deny, not exempt.
        return deny("missing_identity");
    };

    let host = match host_tenant {
        Err(()) => return deny(REASON_HOST_LOOKUP_ERROR),
        Ok(None) => return deny("unknown_host"),
        Ok(Some(host)) => host,
    };

    if host.revoked_at.is_some() {
        return deny("host_revoked");
    }

    if host.project_id != token_project {
        return deny("project_mismatch");
    }

    if let Some(host_org) = host.organization_id.as_deref() {
        if Some(host_org) != token_org {
            return deny("organization_mismatch");
        }
    }

    BindingDecision::Allow
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// A `PrimitiveDateTime` stand-in for "now" — `revoked_at` is
    /// `TIMESTAMP` (no time zone; see `db::ClientHostRow`'s doc comment), and
    /// `evaluate` only ever reads `.is_some()`, so the actual instant is
    /// irrelevant here.
    fn some_primitive_datetime() -> time::PrimitiveDateTime {
        let now = time::OffsetDateTime::now_utc();
        time::PrimitiveDateTime::new(now.date(), now.time())
    }

    fn host(project_id: &str, organization_id: Option<&str>, revoked: bool) -> ClientHostRow {
        ClientHostRow {
            project_id: project_id.to_string(),
            organization_id: organization_id.map(str::to_string),
            revoked_at: revoked.then(some_primitive_datetime),
        }
    }

    // ── from_value / from_env ────────────────────────────────────────────

    #[test]
    fn from_value_off() {
        assert_eq!(BindingMode::from_value("off"), BindingMode::Off);
        assert_eq!(BindingMode::from_value("Off"), BindingMode::Off);
        assert_eq!(BindingMode::from_value("  OFF  "), BindingMode::Off);
    }

    #[test]
    fn from_value_log() {
        assert_eq!(BindingMode::from_value("log"), BindingMode::Log);
        assert_eq!(BindingMode::from_value("LOG"), BindingMode::Log);
    }

    #[test]
    fn from_value_enforce() {
        assert_eq!(BindingMode::from_value("enforce"), BindingMode::Enforce);
        assert_eq!(BindingMode::from_value("Enforce"), BindingMode::Enforce);
    }

    #[test]
    fn from_value_unknown_defaults_to_off() {
        assert_eq!(BindingMode::from_value("bogus"), BindingMode::Off);
    }

    #[test]
    fn from_value_empty_defaults_to_off() {
        assert_eq!(BindingMode::from_value(""), BindingMode::Off);
    }

    // ── evaluate: mode gating ─────────────────────────────────────────────

    #[test]
    fn off_mode_always_allows_no_matter_what_else_is_wrong() {
        // Even a flagrant mismatch is allowed when the mode is Off — this
        // module must be a total no-op in that mode.
        let h = host("proj-B", None, false);
        let decision = evaluate(
            BindingMode::Off,
            true,
            Some("spiffe://onecli/host/1"),
            Ok(Some(&h)),
            "proj-A",
            None,
        );
        assert_eq!(decision, BindingDecision::Allow);
    }

    #[test]
    fn plain_listener_is_exempt_regardless_of_mode_or_mismatch() {
        // `on_mtls = false` must allow even under Enforce, even with a
        // mismatching (or entirely absent) host tenant — subtlety #2.
        for mode in [BindingMode::Log, BindingMode::Enforce] {
            let decision = evaluate(mode, false, None, Ok(None), "proj-A", None);
            assert_eq!(decision, BindingDecision::Allow, "mode={mode:?}");
        }
    }

    // ── evaluate: identity ────────────────────────────────────────────────

    #[test]
    fn mtls_with_no_identity_is_denied_not_exempt() {
        // Subtlety #1: on_mtls=true but identity=None must DENY, not be
        // treated as if it came in on the plain listener.
        let decision = evaluate(BindingMode::Enforce, true, None, Ok(None), "proj-A", None);
        assert_eq!(
            decision,
            BindingDecision::Deny {
                reason: "missing_identity"
            }
        );
    }

    // ── evaluate: lookup outcomes ─────────────────────────────────────────

    #[test]
    fn db_error_denies_fail_closed() {
        let decision = evaluate(
            BindingMode::Enforce,
            true,
            Some("spiffe://onecli/host/1"),
            Err(()),
            "proj-A",
            None,
        );
        assert_eq!(
            decision,
            BindingDecision::Deny {
                reason: REASON_HOST_LOOKUP_ERROR
            }
        );
    }

    #[test]
    fn unknown_host_denies() {
        let decision = evaluate(
            BindingMode::Enforce,
            true,
            Some("spiffe://onecli/host/1"),
            Ok(None),
            "proj-A",
            None,
        );
        assert_eq!(
            decision,
            BindingDecision::Deny {
                reason: "unknown_host"
            }
        );
    }

    #[test]
    fn revoked_host_denies_even_with_matching_project() {
        let h = host("proj-A", None, true);
        let decision = evaluate(
            BindingMode::Enforce,
            true,
            Some("spiffe://onecli/host/1"),
            Ok(Some(&h)),
            "proj-A",
            None,
        );
        assert_eq!(
            decision,
            BindingDecision::Deny {
                reason: "host_revoked"
            }
        );
    }

    // ── evaluate: the binding rule itself ────────────────────────────────

    #[test]
    fn matching_project_no_org_on_host_allows() {
        let h = host("proj-A", None, false);
        let decision = evaluate(
            BindingMode::Enforce,
            true,
            Some("spiffe://onecli/host/1"),
            Ok(Some(&h)),
            "proj-A",
            Some("org-1"),
        );
        assert_eq!(decision, BindingDecision::Allow);
    }

    #[test]
    fn matching_project_and_org_allows() {
        let h = host("proj-A", Some("org-1"), false);
        let decision = evaluate(
            BindingMode::Enforce,
            true,
            Some("spiffe://onecli/host/1"),
            Ok(Some(&h)),
            "proj-A",
            Some("org-1"),
        );
        assert_eq!(decision, BindingDecision::Allow);
    }

    #[test]
    fn project_mismatch_denies() {
        let h = host("proj-B", None, false);
        let decision = evaluate(
            BindingMode::Enforce,
            true,
            Some("spiffe://onecli/host/1"),
            Ok(Some(&h)),
            "proj-A",
            None,
        );
        assert_eq!(
            decision,
            BindingDecision::Deny {
                reason: "project_mismatch"
            }
        );
    }

    #[test]
    fn org_present_on_host_but_mismatched_denies_even_with_matching_project() {
        let h = host("proj-A", Some("org-1"), false);
        let decision = evaluate(
            BindingMode::Enforce,
            true,
            Some("spiffe://onecli/host/1"),
            Ok(Some(&h)),
            "proj-A",
            Some("org-2"),
        );
        assert_eq!(
            decision,
            BindingDecision::Deny {
                reason: "organization_mismatch"
            }
        );
    }

    #[test]
    fn org_present_on_host_but_token_org_none_denies() {
        let h = host("proj-A", Some("org-1"), false);
        let decision = evaluate(
            BindingMode::Enforce,
            true,
            Some("spiffe://onecli/host/1"),
            Ok(Some(&h)),
            "proj-A",
            None,
        );
        assert_eq!(
            decision,
            BindingDecision::Deny {
                reason: "organization_mismatch"
            }
        );
    }

    // ── evaluate: per-mode behavior on an identical mismatch ─────────────

    #[test]
    fn log_mode_would_deny_instead_of_deny() {
        let h = host("proj-B", None, false);
        let decision = evaluate(
            BindingMode::Log,
            true,
            Some("spiffe://onecli/host/1"),
            Ok(Some(&h)),
            "proj-A",
            None,
        );
        assert_eq!(
            decision,
            BindingDecision::WouldDeny {
                reason: "project_mismatch"
            }
        );
    }

    #[test]
    fn enforce_mode_denies() {
        let h = host("proj-B", None, false);
        let decision = evaluate(
            BindingMode::Enforce,
            true,
            Some("spiffe://onecli/host/1"),
            Ok(Some(&h)),
            "proj-A",
            None,
        );
        assert_eq!(
            decision,
            BindingDecision::Deny {
                reason: "project_mismatch"
            }
        );
    }
}
