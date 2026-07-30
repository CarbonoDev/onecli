//! The OSS analogs of the EE overlay loaders: the org-scope published-rule
//! query and the connection's principal-set resolution. OSS-only by
//! construction — the EE builds swap the whole `policy_engine` tree (with
//! their own loaders) via `#[path]` in `main.rs`, so nothing here can collide
//! with the enterprise overlay on merge.
//!
//! Both run ONCE at connection resolution (cached with `ConnectResponse`);
//! the per-request decision path never touches the DB.

use anyhow::{Context, Result};
use sqlx::PgPool;

use crate::db::{PolicyRuleV2Row, PrincipalSet, POLICY_V2_SELECT};

/// Active published ORG-scope rules (max published generation), first-match
/// ordered. Mirrors `db::find_published_policy_rules_v2_by_project` exactly —
/// same SELECT, same generation law, same `ORDER BY priority, id` — with the
/// org arm's fence (`organization_id` + `scope = 'organization'`).
pub(super) async fn find_published_policy_rules_v2_by_org(
    pool: &PgPool,
    organization_id: &str,
) -> Result<Vec<PolicyRuleV2Row>> {
    sqlx::query_as::<_, PolicyRuleV2Row>(&format!(
        r#"{POLICY_V2_SELECT}
           WHERE r.organization_id = $1 AND r.scope = 'organization'
             AND r.status = 'published' AND r.enabled = true
             AND r.generation = (
               SELECT max(generation) FROM policy_rules_v2
               WHERE organization_id = $1 AND scope = 'organization' AND status = 'published')
           ORDER BY r.priority, r.id"#
    ))
    .bind(organization_id)
    .fetch_all(pool)
    .await
    .context("querying org policy_rules_v2 by organization_id")
}

/// One resolved principal set: the two text[] columns of the CTE below.
#[derive(sqlx::FromRow)]
struct PrincipalRow {
    user_ids: Vec<String>,
    group_ids: Vec<String>,
}

/// Resolve the connection's principal set — the humans a proxied request is
/// matched against, and the directory groups they carry. Proxied traffic bears
/// no connecting-user identity (`ProxyContext` is agent-only), so the set is
/// AGENT-INDEPENDENT: one resolution covers every agent of the project. A pure
/// mirror of `resolvePrincipalSet`
/// (packages/api/src/services/policy-simulate/principal-set.ts):
///
/// - `direct_users`  = ProjectAccess rows naming a user;
/// - `direct_groups` = ProjectAccess rows naming a group, ORG-FENCED FIRST
///   (a granted group must belong to this org);
/// - `candidate_users` = direct_users ∪ members of the (org-fenced) direct_groups;
/// - `user_ids` = candidate_users ∩ ACTIVE org members (status <> 'suspended',
///   mirroring the people-gate `user_can_manage_project`);
/// - `group_ids` = direct_groups ∪ every group the resolved user_ids belong to,
///   the latter ORG-FENCED (a user can belong to OTHER orgs' groups).
///
/// Every arm is org-fenced, so a foreign group grant or a user's membership in
/// another org's groups can never leak in. Role-agnostic (presence-only). Run
/// as ONE indexed CTE round-trip (off the hot path — the gateway resolves this
/// at connect, cached with `ConnectResponse`). Keep in lockstep with the TS.
pub(super) async fn load_principal_set(
    pool: &PgPool,
    organization_id: &str,
    project_id: &str,
) -> Result<PrincipalSet> {
    let row: PrincipalRow = sqlx::query_as::<_, PrincipalRow>(
        r#"
        WITH access AS (
            SELECT user_id, group_id FROM project_access WHERE project_id = $1
        ),
        direct_users AS (
            SELECT user_id FROM access WHERE user_id IS NOT NULL
        ),
        direct_groups AS (
            SELECT g.id FROM groups g
            WHERE g.id IN (SELECT group_id FROM access WHERE group_id IS NOT NULL)
              AND g.organization_id = $2
        ),
        candidate_users AS (
            SELECT user_id FROM direct_users
            UNION
            SELECT gm.user_id FROM group_members gm
            WHERE gm.group_id IN (SELECT id FROM direct_groups)
        ),
        active_users AS (
            SELECT om.user_id FROM organization_members om
            WHERE om.user_id IN (SELECT user_id FROM candidate_users)
              AND om.organization_id = $2
              AND om.status <> 'suspended'
        ),
        user_groups AS (
            SELECT gm.group_id FROM group_members gm
            JOIN groups g ON g.id = gm.group_id AND g.organization_id = $2
            WHERE gm.user_id IN (SELECT user_id FROM active_users)
        )
        SELECT
            COALESCE((SELECT array_agg(DISTINCT user_id) FROM active_users), '{}') AS user_ids,
            COALESCE((
                SELECT array_agg(DISTINCT gid) FROM (
                    SELECT id AS gid FROM direct_groups
                    UNION
                    SELECT group_id AS gid FROM user_groups
                ) g
            ), '{}') AS group_ids
        "#,
    )
    .bind(project_id)
    .bind(organization_id)
    .fetch_one(pool)
    .await
    .context("resolving the connection principal set")?;

    Ok(PrincipalSet {
        user_ids: row.user_ids,
        group_ids: row.group_ids,
    })
}

/// True when any loaded rule (org or project, every source — equipment rows
/// matter for inject-selection) carries a directory identity row (user or
/// group). The lazy gate on principal resolution: agent-only configs skip the
/// resolution query entirely. There is no agent-group column, so only user/group
/// rows trigger it.
pub(super) fn has_directory_identity(levels: &[&[PolicyRuleV2Row]]) -> bool {
    levels.iter().flat_map(|rows| rows.iter()).any(|r| {
        r.identities
            .0
            .iter()
            .any(|i| i.user_id.is_some() || i.group_id.is_some())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sqlx::types::Json;

    fn row(identities: serde_json::Value, source: &str) -> PolicyRuleV2Row {
        PolicyRuleV2Row {
            id: "r1".to_string(),
            logical_id: "l1".to_string(),
            name: "rule".to_string(),
            source: source.to_string(),
            priority: 0,
            is_default: false,
            action: "allow".to_string(),
            rate_limit: None,
            rate_limit_window: None,
            require_approval: false,
            conditions: None,
            identities: Json(serde_json::from_value(identities).expect("identities")),
            targets: Json(Vec::new()),
        }
    }

    fn identity(v: serde_json::Value) -> serde_json::Value {
        json!([v])
    }

    #[test]
    fn agent_only_rows_do_not_trigger_principal_resolution() {
        let rows = vec![
            row(json!([]), "custom"),
            row(
                identity(json!({"agentId": "a1", "userId": null, "groupId": null})),
                "custom",
            ),
        ];
        assert!(!has_directory_identity(&[&rows, &[]]));
    }

    #[test]
    fn each_directory_kind_triggers_principal_resolution() {
        for principal in [
            json!({"agentId": null, "userId": "u1", "groupId": null}),
            json!({"agentId": null, "userId": null, "groupId": "g1"}),
        ] {
            let rows = vec![row(identity(principal), "custom")];
            assert!(has_directory_identity(&[&rows, &[]]));
        }
    }

    #[test]
    fn scans_both_levels_and_counts_equipment_rows() {
        let org: Vec<PolicyRuleV2Row> = Vec::new();
        // An equipment row's directory identity matters (inject-selection reads
        // equipment rows), so it must trigger resolution too.
        let project = vec![row(
            identity(json!({"agentId": null, "userId": null, "groupId": "g1"})),
            "equipment",
        )];
        assert!(has_directory_identity(&[&org, &project]));
        assert!(!has_directory_identity(&[&org, &[]]));
    }
}
