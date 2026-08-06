//! The OSS enforce seam: load the published org + project rules (and, when a
//! rule targets a directory identity, the connection's principal set) at
//! connection resolution and decide requests with the two-level first-match
//! core, producing the `policy::PolicyDecision` the forward/websocket act-path
//! understands. The engine is authoritative — there is no legacy fallback.
//!
//! Fail-closed: every resolution query PROPAGATES its error (anyhow) so the
//! caller (`connect.rs`, via `.map_err(db_err)?`) REFUSES the CONNECT rather
//! than caching a policy-free (allow-everything, inject-nothing) state for the
//! ~60s cache cycle. The agent simply retries.
//!
//! HIGH PERFORMANCE: rules load ONCE at connection resolution (cached ~60s
//! with the rest of the connect state); the per-request decision path never
//! touches the DB.

use anyhow::Context;
use sqlx::PgPool;

use crate::cache::CacheStore;
use crate::db::{
    find_connection_providers, find_published_policy_rules_v2_by_project, find_secret_hosts,
    AvailableApps, ConnectionProviders, PolicyRuleV2Row, PolicyV2Rules, PrincipalSet, SecretHosts,
};
use crate::gateway::{strip_port, ProxyContext};
use crate::policy::{check_rate_limit, MatchInput, MatchedRule, PolicyDecision};

use super::assemble::assemble;
use super::evaluate::evaluate_outcome;
use super::loaders;
use super::types::{Action, Outcome, Request, Rule, RuleScope};

/// True iff a loaded rule (org or project) has a BODY condition on a target
/// that could govern this `host` — the host-scoped superset that keeps the
/// buffering as narrow as correctness allows. A network target matches its
/// own `host_pattern`; app/connection/secret targets buffer unconditionally
/// (their host resolution lives in the catalog/fenced maps — not worth
/// duplicating here); unknown kinds never match anything. Header-only
/// conditions never buffer (headers are always available); equipment rows are
/// injection-only and skipped; empty slices never buffer.
///
/// The superset law: `needs_body_buffer` must be TRUE whenever some body
/// condition could be consulted for this host, so the matcher only ever sees
/// `body: None` for a request that genuinely had no body — never for one whose
/// body was skipped by the streaming path.
pub(crate) fn needs_body_buffer(v2: &PolicyV2Rules, host: &str) -> bool {
    let host = strip_port(host);
    v2.org
        .iter()
        .chain(v2.project.iter())
        .filter(|r| r.source != "equipment")
        .filter(|r| crate::condition_match::has_body_condition(&r.conditions))
        .any(|r| {
            r.targets.0.iter().any(|t| match t.kind.as_str() {
                "network" => t
                    .host_pattern
                    .as_deref()
                    .is_some_and(|p| crate::connect::host_matches(host, p)),
                "app" | "connection" | "secret" => true,
                _ => false,
            })
        })
}

/// True when any loaded rule (org or project) has a target of `kind`, skipping
/// equipment rows (injection-only — dropped by the assembler, so their
/// secret/connection targets never need host/provider resolution). The lazy
/// gate that keeps the common connect resolution free of the two extra queries.
fn has_target_kind(levels: &[&[PolicyRuleV2Row]], kind: &str) -> bool {
    levels
        .iter()
        .flat_map(|rows| rows.iter())
        .filter(|r| r.source != "equipment")
        .any(|r| r.targets.0.iter().any(|t| t.kind == kind))
}

/// Load the published org + project rules (and lazily the principal set) at
/// resolution time — cached with `ConnectResponse`, off the per-request hot
/// path. Principals, secret hosts, and connection providers resolve lazily,
/// only when some loaded rule needs them. Any load error PROPAGATES: the caller
/// refuses the CONNECT rather than caching a policy-free state for the ~60s
/// cache cycle.
pub(crate) async fn load_connect_v2(
    pool: &PgPool,
    org_id: &str,
    project_id: &str,
) -> anyhow::Result<PolicyV2Rules> {
    let org = loaders::find_published_policy_rules_v2_by_org(pool, org_id)
        .await
        .context("policy v2: org load failed at resolution")?;
    let project = find_published_policy_rules_v2_by_project(pool, project_id)
        .await
        .context("policy v2: project load failed at resolution")?;
    // Principals resolve lazily: only when some loaded rule (org or project,
    // equipment included — inject-selection matches against them too) carries a
    // directory identity. The set is agent-independent, so `agent_id` is not a
    // parameter. The common agent-only connect stays at zero extra queries.
    let principals = if loaders::has_directory_identity(&[&org, &project]) {
        loaders::load_principal_set(pool, org_id, project_id)
            .await
            .context("policy v2: principal resolution failed at resolution")?
    } else {
        PrincipalSet::default()
    };
    let secret_hosts = if has_target_kind(&[&org, &project], "secret") {
        find_secret_hosts(pool, org_id, project_id)
            .await
            .context("policy v2: secret-host resolution failed at resolution")?
    } else {
        SecretHosts::default()
    };
    let connection_providers = if has_target_kind(&[&org, &project], "connection") {
        find_connection_providers(pool, org_id, project_id)
            .await
            .context("policy v2: connection-provider resolution failed at resolution")?
    } else {
        ConnectionProviders::default()
    };
    Ok(PolicyV2Rules {
        org,
        project,
        principals,
        secret_hosts,
        connection_providers,
    })
}

/// "All apps available" always: app availability is a OneCLI Cloud capability;
/// the shared pre-check stays structurally inert here.
pub(crate) async fn load_available_apps(
    _pool: &PgPool,
    _org_id: &str,
    _project_id: &str,
) -> AvailableApps {
    AvailableApps::default()
}

/// Map the winning rule to a `PolicyDecision`, running the rate counter
/// (keyed on `logical_id`, stable across republishes).
async fn decision_for_rule(
    rule: &Rule,
    org_id: &str,
    project_id: &str,
    agent_token: &str,
    cache: &dyn CacheStore,
) -> PolicyDecision {
    if rule.action == Action::Block {
        return PolicyDecision::Blocked {
            rule_name: rule.name.clone(),
        };
    }
    if rule.require_approval {
        return PolicyDecision::ManualApproval {
            rule_id: rule.id.clone(),
        };
    }
    if let (Some(limit), Some(window)) = (rule.rate_limit, rule.rate_limit_window) {
        if let Some(decision) = check_rate_limit(
            org_id,
            project_id,
            &rule.logical_id,
            &rule.name,
            limit,
            window.secs(),
            agent_token,
            cache,
        )
        .await
        {
            return decision;
        }
    }
    PolicyDecision::Allow
}

/// Decide via the OSS two-level core over the already-resolved org + project
/// rules. No DB access. If the identity is somehow incomplete, the decision is
/// `Allow` — the engine is authoritative, so there is no fallback.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn evaluate(
    proxy_ctx: &ProxyContext,
    host: &str,
    method: &str,
    path: &str,
    input: &MatchInput<'_>,
    has_injections: bool,
    is_llm_host: bool,
    winning_connection_id: Option<&str>,
    cache: &dyn CacheStore,
    v2: &PolicyV2Rules,
) -> (PolicyDecision, Option<MatchedRule>) {
    let (Some(org_id), Some(project_id), Some(agent_id)) = (
        proxy_ctx.organization_id.as_deref(),
        proxy_ctx.project_id.as_deref(),
        proxy_ctx.agent_id.as_deref(),
    ) else {
        return (PolicyDecision::Allow, None);
    };
    let agent_token = proxy_ctx.agent_token.as_deref().unwrap_or("");

    let org_rules = assemble(
        &v2.org,
        RuleScope::Organization,
        &v2.secret_hosts,
        &v2.connection_providers,
    );
    let project_rules = assemble(
        &v2.project,
        RuleScope::Project,
        &v2.secret_hosts,
        &v2.connection_providers,
    );
    let request = Request {
        host: strip_port(host).to_string(),
        path: path.to_string(),
        method: method.to_string(),
        agent_id: agent_id.to_string(),
        has_injections,
        is_llm_host,
        winning_connection_id: winning_connection_id.map(str::to_string),
    };

    let matched_of = |rule: &Rule| MatchedRule {
        logical_id: rule.logical_id.clone(),
        name: rule.name.clone(),
        scope: rule.scope.as_str().to_string(),
    };
    match evaluate_outcome(&org_rules, &project_rules, &request, &v2.principals, input) {
        Outcome::Rule(rule) => (
            decision_for_rule(rule, org_id, project_id, agent_token, cache).await,
            Some(matched_of(rule)),
        ),
        Outcome::DenyDefault(default_rule) => (
            PolicyDecision::BlockedByDefaultPolicy,
            Some(matched_of(default_rule)),
        ),
        Outcome::Allow => (PolicyDecision::Allow, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sqlx::types::Json;

    fn row(over: impl FnOnce(&mut PolicyRuleV2Row)) -> PolicyRuleV2Row {
        let mut r = PolicyRuleV2Row {
            id: "r1".to_string(),
            logical_id: "l1".to_string(),
            name: "rule".to_string(),
            source: "custom".to_string(),
            priority: 0,
            is_default: false,
            action: "allow".to_string(),
            rate_limit: None,
            rate_limit_window: None,
            require_approval: false,
            conditions: None,
            identities: Json(Vec::new()),
            targets: Json(Vec::new()),
        };
        over(&mut r);
        r
    }

    fn proxy_ctx() -> ProxyContext {
        ProxyContext {
            project_id: Some("p1".to_string()),
            organization_id: Some("o1".to_string()),
            agent_id: Some("a1".to_string()),
            agent_token: Some("t".to_string()),
            ..Default::default()
        }
    }

    fn network_target() -> serde_json::Value {
        json!({"kind": "network", "hostPattern": "api.example.com"})
    }

    /// An org rule scoped to a directory GROUP, plus a project Default Rule.
    fn org_group_block_bundle(principals: PrincipalSet) -> PolicyV2Rules {
        PolicyV2Rules {
            org: vec![row(|r| {
                r.action = "block".to_string();
                r.identities = Json(
                    serde_json::from_value(json!([
                        {"agentId": null, "userId": null, "groupId": "g1"}
                    ]))
                    .expect("identity rows"),
                );
                r.targets = Json(vec![
                    serde_json::from_value(network_target()).expect("target row")
                ]);
            })],
            project: vec![row(|r| r.is_default = true)],
            principals,
            ..PolicyV2Rules::default()
        }
    }

    async fn run_seam(v2: &PolicyV2Rules) -> (PolicyDecision, Option<MatchedRule>) {
        let store = crate::cache::create_store().await.expect("store");
        evaluate(
            &proxy_ctx(),
            "api.example.com",
            "GET",
            "/",
            &MatchInput::empty(),
            false,
            false,
            None,
            store.as_ref(),
            v2,
        )
        .await
    }

    /// Test #1/#3: the seam wires `&v2.org` → the org assemble, `&v2.principals`
    /// → the evaluator (a g1 membership matches), and `matched_of` attributes
    /// the org scope end-to-end.
    #[tokio::test]
    async fn evaluate_enforces_an_org_group_rule_through_the_seam() {
        let v2 = org_group_block_bundle(PrincipalSet {
            group_ids: vec!["g1".to_string()],
            ..PrincipalSet::default()
        });
        let (decision, matched) = run_seam(&v2).await;
        assert!(matches!(decision, PolicyDecision::Blocked { .. }));
        let m = matched.expect("the winning org rule must be attributed");
        assert_eq!(m.scope, "organization");
    }

    /// The companion regression: an EMPTY principal set narrows the same org
    /// group rule to nothing → Allow. A `PrincipalSet::default()` wired into the
    /// seam would flip the test above, never this one.
    #[tokio::test]
    async fn empty_principals_narrow_the_org_group_rule_to_nothing() {
        let v2 = org_group_block_bundle(PrincipalSet::default());
        let (decision, matched) = run_seam(&v2).await;
        assert!(matches!(decision, PolicyDecision::Allow));
        assert!(matched.is_none());
    }

    #[test]
    fn has_target_kind_scans_org_and_project_and_skips_equipment() {
        let org = vec![row(|r| {
            r.targets = Json(vec![serde_json::from_value(
                json!({"kind": "secret", "secretId": "s1"}),
            )
            .expect("target row")]);
        })];
        let project: Vec<PolicyRuleV2Row> = Vec::new();
        assert!(has_target_kind(&[&org, &project], "secret"));
        assert!(!has_target_kind(&[&org, &project], "connection"));
        // Equipment rows stay excluded — they are injection-only.
        let equipment = vec![row(|r| {
            r.source = "equipment".to_string();
            r.targets = Json(vec![serde_json::from_value(
                json!({"kind": "secret", "secretId": "s1"}),
            )
            .expect("target row")]);
        })];
        assert!(!has_target_kind(&[&equipment, &project], "secret"));
    }

    #[test]
    fn needs_body_buffer_scopes_to_host_and_skips_equipment() {
        let body_cond: Option<serde_json::Value> =
            serde_json::from_str(r#"[{"target":"body","operator":"contains","value":"x"}]"#).ok();
        let network_rule = |conditions: Option<serde_json::Value>| {
            row(|r| {
                r.conditions = conditions;
                r.targets = Json(vec![serde_json::from_value(
                    json!({"kind": "network", "hostPattern": "api.example.com"}),
                )
                .expect("target row")]);
            })
        };
        // Network-target rule with a body condition: only its host buffers
        // (port-stripped), foreign hosts keep streaming.
        let v2 = PolicyV2Rules {
            project: vec![network_rule(body_cond.clone())],
            ..PolicyV2Rules::default()
        };
        assert!(needs_body_buffer(&v2, "api.example.com"));
        assert!(needs_body_buffer(&v2, "api.example.com:443"));
        assert!(!needs_body_buffer(&v2, "other.example.com"));
        // Org-scope rules count too.
        let v2 = PolicyV2Rules {
            org: vec![network_rule(body_cond.clone())],
            ..PolicyV2Rules::default()
        };
        assert!(needs_body_buffer(&v2, "api.example.com"));
        // App-target rule → conservatively buffer everywhere (superset law).
        let app_rule = row(|r| {
            r.conditions = body_cond.clone();
            r.targets = Json(vec![serde_json::from_value(
                json!({"kind": "app", "appProvider": "github", "appTools": []}),
            )
            .expect("target row")]);
        });
        let v2 = PolicyV2Rules {
            project: vec![app_rule],
            ..PolicyV2Rules::default()
        };
        assert!(needs_body_buffer(&v2, "anything.example.com"));
        // Equipment rows are injection-only — never buffer.
        let equipment = row(|r| {
            r.source = "equipment".to_string();
            r.conditions = body_cond.clone();
            r.targets = Json(vec![serde_json::from_value(
                json!({"kind": "network", "hostPattern": "api.example.com"}),
            )
            .expect("target row")]);
        });
        let v2 = PolicyV2Rules {
            project: vec![equipment],
            ..PolicyV2Rules::default()
        };
        assert!(!needs_body_buffer(&v2, "api.example.com"));
        // Header-only conditions never buffer (headers are always available).
        let header_cond: Option<serde_json::Value> =
            serde_json::from_str(r#"[{"target":"header","operator":"exists","key":"x-k"}]"#).ok();
        let v2 = PolicyV2Rules {
            project: vec![network_rule(header_cond)],
            ..PolicyV2Rules::default()
        };
        assert!(!needs_body_buffer(&v2, "api.example.com"));
        // Empty bundle never buffers.
        assert!(!needs_body_buffer(
            &PolicyV2Rules::default(),
            "api.example.com"
        ));
    }
}
