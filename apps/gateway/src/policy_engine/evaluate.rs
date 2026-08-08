//! The OSS two-level first-match evaluator, mirroring the canonical
//! `policy-translation/evaluator.ts` (`evaluatePolicyOutcome`): per-scope
//! first-match (org, then project), combined by STRICTEST (block strictest …
//! allow loosest), with each level's Default Rule as its fallback verdict
//! (deny wins), PLUS the HARD-FLOOR rule — a lone ALLOW at one level cannot
//! open the OTHER level's default-Block. Org-first tie-break.
//!
//! Why two levels rather than one merged list: a project rule may shadow a
//! project sibling, but must NEVER override an org guardrail. A single merged
//! first-match can honor at most one of "identity beats strictness" and "org is
//! un-overridable"; splitting org/project and combining by strictest honors both.
//!
//! Matching routes through the gateway's own `connect::host_matches` +
//! `policy::matches_request`, so path globs, methods, the git-receive-pack
//! bridge, and the body/header condition arm are byte-identical to the shared
//! matcher. Conditions are evaluated at BOTH scopes: every rule's own
//! Block-ness rides through the pseudo-rule seam, so an unevaluable condition
//! fails CLOSED by action (a Block over-blocks, an Allow falls through).

use crate::db::PrincipalSet;
use crate::policy::{matches_request, MatchInput, PolicyAction, PolicyRule};

use super::types::{Action, Identity, Outcome, Request, Rule, Target};

/// Empty identities = "any"; an `Agent` identity matches the acting agent by
/// id; the directory kinds (`User`/`Group`) match against the connection's
/// resolved principal set; `Other` (a row naming no principal the OSS engine
/// understands) never matches. Linear scans are fine — principal sets are small.
fn identity_matches(rule: &Rule, request: &Request, principals: &PrincipalSet) -> bool {
    rule.identities.is_empty()
        || rule.identities.iter().any(|i| match i {
            Identity::Agent(id) => *id == request.agent_id,
            Identity::User(id) => principals.user_ids.contains(id),
            Identity::Group(id) => principals.group_ids.contains(id),
            Identity::Other => false,
        })
}

/// A throwaway `policy::PolicyRule` so the network match runs the gateway's
/// exact `matches_request`. Conditions ride from the owning rule, and so does
/// its BLOCK-ness (`is_block`): `condition_match`'s failure law is
/// action-aware — an unevaluable condition fails CLOSED only for a Block rule
/// — so hardcoding Allow here would fail a v2 Block rule OPEN on a broken
/// regex/oversized body. The owning rule's NAME rides along too, so the
/// matcher's unevaluable-condition warning identifies the broken rule instead
/// of logging an empty name.
fn pseudo_rule(
    name: &str,
    path_pattern: Option<&str>,
    method: Option<String>,
    conditions: &Option<serde_json::Value>,
    is_block: bool,
) -> PolicyRule {
    PolicyRule {
        name: name.to_string(),
        path_pattern: path_pattern.unwrap_or("*").to_string(),
        method,
        action: if is_block {
            PolicyAction::Block
        } else {
            PolicyAction::Allow
        },
        conditions_raw: conditions.clone(),
    }
}

fn target_matches(target: &Target, rule: &Rule, request: &Request, input: &MatchInput<'_>) -> bool {
    let is_block = rule.action == Action::Block;
    match target {
        Target::Network {
            host_pattern,
            path_pattern,
            method,
        } => {
            crate::connect::host_matches(&request.host, host_pattern)
                && matches_request(
                    &pseudo_rule(
                        &rule.name,
                        path_pattern.as_deref(),
                        method.clone(),
                        &rule.conditions,
                        is_block,
                    ),
                    &request.method,
                    &request.path,
                    input,
                )
        }
        Target::App { provider, tools } => super::catalog::app_target_matches(
            &rule.name,
            provider,
            tools,
            &request.host,
            &request.method,
            &request.path,
            input,
            &rule.conditions,
            is_block,
        ),
        // A connection target matches only when it is the request's winning
        // injected connection AND the provider/tools fan-out hits. No winner →
        // never matches (fail-closed for allow AND block). Conditions ride
        // through the fan-out carrying the owning rule's Block-ness.
        Target::Connection {
            id,
            provider,
            tools,
        } => {
            request.winning_connection_id.as_deref() == Some(id.as_str())
                && super::catalog::app_target_matches(
                    &rule.name,
                    provider,
                    tools,
                    &request.host,
                    &request.method,
                    &request.path,
                    input,
                    &rule.conditions,
                    is_block,
                )
        }
        // A secret target gates its resolved host(s). Empty patterns
        // (unresolved/deleted secret) never match — fail-closed. The owning
        // rule's conditions still narrow the match (wildcard-path pseudo-rule
        // carrying its Block-ness): without this gate a conditioned ALLOW on a
        // secret would match unconditionally and could shadow a later Block —
        // the widening the fail-closed law forbids.
        Target::Secret { host_patterns } => {
            host_patterns
                .iter()
                .any(|h| crate::connect::host_matches(&request.host, h))
                && matches_request(
                    &pseudo_rule(&rule.name, None, None, &rule.conditions, is_block),
                    &request.method,
                    &request.path,
                    input,
                )
        }
        Target::Unresolved => false,
    }
}

/// A non-default rule matches only when it names at least one target AND one of
/// them matches. Empty targets = matches NOTHING: "match everything" is the
/// Default Rule's job, never an empty list — which also neutralizes a rule
/// orphaned to zero targets by an FK cascade (fail-closed).
fn rule_matches(
    rule: &Rule,
    request: &Request,
    principals: &PrincipalSet,
    input: &MatchInput<'_>,
) -> bool {
    identity_matches(rule, request, principals)
        && !rule.targets.is_empty()
        && rule
            .targets
            .iter()
            .any(|t| target_matches(t, rule, request, input))
}

/// Strictness rank, mirroring `strictness.ts::strictnessRank`: block strictest
/// (0) … allow loosest (3). LOWER is stricter, so the reduce below keeps the
/// smaller rank. (A rate-limit modifier ranks by its presence alone, exactly
/// as the TS does — `rateLimit !== null`.)
fn strictness_rank(rule: &Rule) -> u8 {
    if rule.action == Action::Block {
        0
    } else if rule.require_approval {
        1
    } else if rule.rate_limit.is_some() {
        2
    } else {
        3
    }
}

/// A level's first matching non-default rule, carrying its strictness rank.
#[derive(Clone, Copy)]
struct LevelMatch<'a> {
    rank: u8,
    rule: &'a Rule,
}

/// First matching non-default rule of one level in `(priority, id)` order. The
/// id tie-break makes equal priorities total and deterministic, agreeing with
/// the DB's `ORDER BY r.priority, r.id` (ids are lowercase-hex UUIDs, so Rust
/// byte order equals the Postgres collation).
fn first_match<'a>(
    rules: &'a [Rule],
    request: &Request,
    principals: &PrincipalSet,
    input: &MatchInput<'_>,
) -> Option<LevelMatch<'a>> {
    let mut ordered: Vec<&'a Rule> = rules.iter().filter(|r| !r.is_default).collect();
    ordered.sort_by(|a, b| a.priority.cmp(&b.priority).then_with(|| a.id.cmp(&b.id)));
    ordered
        .into_iter()
        .find(|rule| rule_matches(rule, request, principals, input))
        .map(|rule| LevelMatch {
            rank: strictness_rank(rule),
            rule,
        })
}

/// Decide the request under the two-level hard-floor law, a faithful port of
/// `evaluator.ts::evaluatePolicyOutcome`:
///
/// - each level's verdict is its first matching explicit rule (else nothing);
/// - a Default-Block is a HARD FLOOR at its level (gated by the `enforce_deny`
///   carve): a lone ALLOW at the OTHER level is DROPPED so it can't open it —
///   an org allow can't punch through a project allowlist floor, and a project
///   allow can't punch through an org default-Block; a BLOCK still applies (it
///   only tightens);
/// - surviving matches combine by STRICTEST (lower rank wins), org-first on a
///   tie (the org rate/approval modifier wins);
/// - with no surviving match the level defaults decide, deny-wins, org-first.
///
/// Only ONE rule ever decides — modifiers never stack across levels.
pub(super) fn evaluate_outcome<'a>(
    org_rules: &'a [Rule],
    project_rules: &'a [Rule],
    request: &Request,
    principals: &PrincipalSet,
    input: &MatchInput<'_>,
) -> Outcome<'a> {
    let org_default = org_rules.iter().find(|r| r.is_default);
    let project_default = project_rules.iter().find(|r| r.is_default);

    let org_match = first_match(org_rules, request, principals, input);
    let project_match = first_match(project_rules, request, principals, input);

    // A Default-Block is enforced only under the carve (credentialed, non-LLM),
    // at EVERY level.
    let enforce_deny = request.enforce_deny();
    let org_default_blocks = org_default.is_some_and(|d| d.action == Action::Block) && enforce_deny;
    let project_default_blocks =
        project_default.is_some_and(|d| d.action == Action::Block) && enforce_deny;

    // A lone org ALLOW can't punch through the project default-Block (allowlist
    // mode) — drop it so it falls through to the deny-default. An org BLOCK
    // still applies (it only tightens). Approval/rate rules are action "allow",
    // so they defer too — symmetric with the org floor below.
    let effective_org = if project_match.is_none()
        && matches!(org_match, Some(m) if m.rule.action == Action::Allow)
        && project_default_blocks
    {
        None
    } else {
        org_match
    };

    // A lone project ALLOW can't punch through the org default-Block — drop it
    // so it falls through to the deny-default. A project BLOCK still applies (it
    // only tightens); an allow-posture org lets the project allow win.
    let effective_project = if org_match.is_none()
        && matches!(project_match, Some(m) if m.rule.action == Action::Allow)
        && org_default_blocks
    {
        None
    } else {
        project_match
    };

    // Combine by strictest (lower rank = stricter); on a tie keep the org match
    // (left bias) so the org modifier wins, matching the oracle's org-first pass.
    let best = [effective_org, effective_project]
        .into_iter()
        .flatten()
        .reduce(|a, b| if b.rank < a.rank { b } else { a });
    if let Some(best) = best {
        return Outcome::Rule(best.rule);
    }

    // No explicit rule survived → the level defaults decide; deny wins,
    // attributed org-first (the org default is checked first at the gateway).
    if org_default_blocks {
        if let Some(d) = org_default {
            return Outcome::DenyDefault(d);
        }
    }
    if project_default_blocks {
        if let Some(d) = project_default {
            return Outcome::DenyDefault(d);
        }
    }
    Outcome::Allow
}

#[cfg(test)]
mod tests {
    use super::super::types::{Action, RateWindow, RuleScope};
    use super::*;

    fn rule(id: &str, priority: usize, action: Action) -> Rule {
        Rule {
            id: id.to_string(),
            scope: RuleScope::Project,
            logical_id: format!("l-{id}"),
            name: id.to_string(),
            priority,
            is_default: false,
            identities: Vec::new(),
            targets: vec![Target::Network {
                host_pattern: "api.example.com".to_string(),
                path_pattern: None,
                method: None,
            }],
            action,
            require_approval: false,
            rate_limit: None,
            rate_limit_window: None,
            conditions: None,
        }
    }

    fn org_rule(id: &str, priority: usize, action: Action) -> Rule {
        Rule {
            scope: RuleScope::Organization,
            ..rule(id, priority, action)
        }
    }

    fn approval_rule(id: &str, priority: usize) -> Rule {
        let mut r = rule(id, priority, Action::Allow);
        r.require_approval = true;
        r
    }

    fn rate_rule(id: &str, priority: usize) -> Rule {
        let mut r = rule(id, priority, Action::Allow);
        r.rate_limit = Some(5);
        r.rate_limit_window = Some(RateWindow::Minute);
        r
    }

    fn default_rule(action: Action) -> Rule {
        let mut r = rule("default", 99, action);
        r.is_default = true;
        r.targets = Vec::new();
        r
    }

    fn org_default(action: Action) -> Rule {
        Rule {
            scope: RuleScope::Organization,
            ..default_rule(action)
        }
    }

    fn no_principals() -> PrincipalSet {
        PrincipalSet::default()
    }

    fn principals() -> PrincipalSet {
        PrincipalSet {
            user_ids: vec!["u-1".to_string()],
            group_ids: vec!["g-1".to_string()],
        }
    }

    fn request() -> Request {
        Request {
            host: "api.example.com".to_string(),
            path: "/x".to_string(),
            method: "GET".to_string(),
            agent_id: "agent-1".to_string(),
            has_injections: false,
            is_llm_host: false,
            winning_connection_id: None,
        }
    }

    fn injected_request() -> Request {
        Request {
            has_injections: true,
            ..request()
        }
    }

    // ── Single-level (project) reductions — the org slice is empty ──────

    #[test]
    fn first_match_wins_by_priority() {
        let rules = vec![rule("b", 1, Action::Block), rule("a", 0, Action::Allow)];
        match evaluate_outcome(
            &[],
            &rules,
            &request(),
            &no_principals(),
            &MatchInput::empty(),
        ) {
            Outcome::Rule(r) => assert_eq!(r.id, "a"),
            _ => panic!("expected a rule match"),
        }
    }

    #[test]
    fn equal_priority_ties_break_by_id_regardless_of_input_order() {
        for rules in [
            vec![rule("a", 5, Action::Allow), rule("b", 5, Action::Block)],
            vec![rule("b", 5, Action::Block), rule("a", 5, Action::Allow)],
        ] {
            match evaluate_outcome(
                &[],
                &rules,
                &request(),
                &no_principals(),
                &MatchInput::empty(),
            ) {
                Outcome::Rule(r) => assert_eq!(r.id, "a", "lower id wins the tie"),
                _ => panic!("expected a rule match"),
            }
        }
    }

    /// Test #11 (part): `Other` never matches; empty identities = any.
    #[test]
    fn agent_identity_scopes_and_other_never_matches() {
        let mut agent_scoped = rule("scoped", 0, Action::Block);
        agent_scoped.identities = vec![Identity::Agent("agent-1".to_string())];
        let mut other = rule("directory", 1, Action::Block);
        other.identities = vec![Identity::Other];
        let allow = rule("any", 2, Action::Allow);

        let rules = vec![agent_scoped, other, allow];
        match evaluate_outcome(
            &[],
            &rules,
            &request(),
            &no_principals(),
            &MatchInput::empty(),
        ) {
            Outcome::Rule(r) => assert_eq!(r.id, "scoped"),
            _ => panic!("expected the agent-scoped match"),
        }
        let mut foreign = request();
        foreign.agent_id = "agent-2".to_string();
        match evaluate_outcome(
            &[],
            &rules,
            &foreign,
            &no_principals(),
            &MatchInput::empty(),
        ) {
            // The directory identity must NOT match — the any-agent allow wins.
            Outcome::Rule(r) => assert_eq!(r.id, "any"),
            _ => panic!("expected the any-agent match"),
        }
    }

    /// Test #11 (part): an empty-target rule is inert.
    #[test]
    fn empty_target_rule_is_inert() {
        let mut orphan = rule("orphan", 0, Action::Block);
        orphan.targets = Vec::new();
        let control = rule("control", 1, Action::Allow);
        match evaluate_outcome(
            &[],
            &[orphan, control],
            &request(),
            &no_principals(),
            &MatchInput::empty(),
        ) {
            Outcome::Rule(r) => assert_eq!(r.id, "control"),
            _ => panic!("expected the control match"),
        }
    }

    /// Test #10 (project level): the Default Rule Block enforces only under the
    /// `enforce_deny` carve.
    #[test]
    fn default_block_enforces_only_under_the_carve() {
        let rules = vec![default_rule(Action::Block)];
        // Uncredentialed → the carve spares it.
        assert!(matches!(
            evaluate_outcome(
                &[],
                &rules,
                &request(),
                &no_principals(),
                &MatchInput::empty()
            ),
            Outcome::Allow
        ));
        // Credentialed non-LLM → blocked, attributed to the Default Rule.
        match evaluate_outcome(
            &[],
            &rules,
            &injected_request(),
            &no_principals(),
            &MatchInput::empty(),
        ) {
            Outcome::DenyDefault(d) => assert!(d.is_default),
            _ => panic!("expected the deny-default"),
        }
        // LLM host → spared.
        let mut llm = injected_request();
        llm.is_llm_host = true;
        assert!(matches!(
            evaluate_outcome(&[], &rules, &llm, &no_principals(), &MatchInput::empty()),
            Outcome::Allow
        ));
    }

    #[test]
    fn explicit_allow_opens_the_same_level_default_block() {
        let rules = vec![rule("open", 0, Action::Allow), default_rule(Action::Block)];
        match evaluate_outcome(
            &[],
            &rules,
            &injected_request(),
            &no_principals(),
            &MatchInput::empty(),
        ) {
            Outcome::Rule(r) => assert_eq!(r.id, "open"),
            _ => panic!("expected the allow rule to win over its own default block"),
        }
    }

    #[test]
    fn default_allow_is_neutral() {
        let rules = vec![default_rule(Action::Allow)];
        assert!(matches!(
            evaluate_outcome(
                &[],
                &rules,
                &injected_request(),
                &no_principals(),
                &MatchInput::empty()
            ),
            Outcome::Allow
        ));
    }

    // ── Stage-G: conditions are evaluated at both scopes ────────────────

    fn conditioned(id: &str, priority: usize, action: Action, conditions: &str) -> Rule {
        let mut r = rule(id, priority, action);
        r.conditions = serde_json::from_str(conditions).ok();
        r
    }

    fn body_input(body: &[u8]) -> MatchInput<'_> {
        MatchInput {
            body: Some(body),
            body_truncated: false,
            headers: None,
        }
    }

    #[test]
    fn conditioned_block_falls_through_when_body_lacks_the_needle() {
        // OSS evaluates conditions since Tier 3a (this test used to pin the
        // opposite no-op posture): a body-conditioned block whose needle is
        // absent falls through and the next rule wins.
        let rules = vec![
            conditioned(
                "cond",
                0,
                Action::Block,
                r#"[{"target":"body","operator":"contains","value":"needle"}]"#,
            ),
            rule("open", 1, Action::Allow),
        ];
        match evaluate_outcome(
            &[],
            &rules,
            &request(),
            &no_principals(),
            &body_input(b"no match here"),
        ) {
            Outcome::Rule(r) => assert_eq!(r.id, "open"),
            _ => panic!("expected the conditioned block to fall through"),
        }
    }

    #[test]
    fn conditioned_block_matches_when_body_contains_the_needle() {
        let rules = vec![
            conditioned(
                "cond",
                0,
                Action::Block,
                r#"[{"target":"body","operator":"contains","value":"needle"}]"#,
            ),
            rule("open", 1, Action::Allow),
        ];
        match evaluate_outcome(
            &[],
            &rules,
            &request(),
            &no_principals(),
            &body_input(b"the needle is here"),
        ) {
            Outcome::Rule(r) => assert_eq!(r.id, "cond"),
            _ => panic!("expected the conditioned block to match"),
        }
    }

    #[test]
    fn invalid_condition_on_a_v2_block_still_blocks() {
        // Pins the pseudo-rule action mapping: the failure law is action-aware,
        // so a Block rule with an uncompilable regex must still BLOCK. This
        // test fails if `pseudo_rule` hardcodes Allow.
        let rules = vec![
            conditioned(
                "broken",
                0,
                Action::Block,
                r#"[{"target":"body","operator":"regex","value":"(?<=x)["}]"#,
            ),
            rule("open", 1, Action::Allow),
        ];
        match evaluate_outcome(
            &[],
            &rules,
            &request(),
            &no_principals(),
            &body_input(b"anything"),
        ) {
            Outcome::Rule(r) => assert_eq!(r.id, "broken", "Block must fail CLOSED"),
            _ => panic!("expected the broken-condition block to match"),
        }
        // The symmetric guard: the same broken condition on an ALLOW rule
        // falls through (it must not shadow a later block).
        let rules = vec![
            conditioned(
                "broken-allow",
                0,
                Action::Allow,
                r#"[{"target":"body","operator":"regex","value":"(?<=x)["}]"#,
            ),
            rule("blocker", 1, Action::Block),
        ];
        match evaluate_outcome(
            &[],
            &rules,
            &request(),
            &no_principals(),
            &body_input(b"anything"),
        ) {
            Outcome::Rule(r) => assert_eq!(r.id, "blocker"),
            _ => panic!("expected the broken-condition allow to fall through"),
        }
    }

    #[test]
    fn conditions_are_enforced_at_the_org_scope_too() {
        // The fail-closed-by-action law holds at BOTH scopes (F routes org and
        // project through the same seam): an org-scope Block whose broken regex
        // is unevaluable fails CLOSED, over-blocking even a project allow.
        let org = vec![{
            let mut r = conditioned(
                "org-broken",
                0,
                Action::Block,
                r#"[{"target":"body","operator":"regex","value":"("}]"#,
            );
            r.scope = RuleScope::Organization;
            r
        }];
        let project = vec![rule("proj-allow", 0, Action::Allow)];
        match evaluate_outcome(
            &org,
            &project,
            &request(),
            &no_principals(),
            &body_input(b"anything"),
        ) {
            Outcome::Rule(r) => {
                assert_eq!(r.id, "org-broken", "org Block must fail closed");
                assert_eq!(r.scope, RuleScope::Organization);
            }
            _ => panic!("expected the org broken-condition block"),
        }
        // The same org rule as an ALLOW falls through — its broken condition
        // cannot widen or shadow the project block.
        let org = vec![{
            let mut r = conditioned(
                "org-broken-allow",
                0,
                Action::Allow,
                r#"[{"target":"body","operator":"regex","value":"("}]"#,
            );
            r.scope = RuleScope::Organization;
            r
        }];
        let project = vec![rule("proj-block", 0, Action::Block)];
        match evaluate_outcome(
            &org,
            &project,
            &request(),
            &no_principals(),
            &body_input(b"anything"),
        ) {
            Outcome::Rule(r) => assert_eq!(r.id, "proj-block"),
            _ => panic!("the broken org allow must not shadow the project block"),
        }
    }

    #[test]
    fn secret_target_honors_conditions_and_fails_closed_by_action() {
        let secret_target = || {
            vec![Target::Secret {
                host_patterns: vec!["api.example.com".to_string()],
            }]
        };
        let cond = r#"[{"target":"body","operator":"contains","value":"needle"}]"#;
        // A conditioned ALLOW on a secret must NOT match unconditionally — it
        // would shadow the later Block (the widening the fail-closed law
        // forbids).
        let mut cond_allow = conditioned("sec-allow", 0, Action::Allow, cond);
        cond_allow.targets = secret_target();
        let mut blocker = rule("blocker", 1, Action::Block);
        blocker.targets = secret_target();
        let rules = vec![cond_allow, blocker];
        match evaluate_outcome(
            &[],
            &rules,
            &request(),
            &no_principals(),
            &body_input(b"no match here"),
        ) {
            Outcome::Rule(r) => assert_eq!(r.id, "blocker", "allow must fall through"),
            _ => panic!("expected the block"),
        }
        // With the needle present the conditioned allow matches first.
        match evaluate_outcome(
            &[],
            &rules,
            &request(),
            &no_principals(),
            &body_input(b"has needle"),
        ) {
            Outcome::Rule(r) => assert_eq!(r.id, "sec-allow"),
            _ => panic!("expected the conditioned allow"),
        }
        // An unevaluable condition on a secret-target Block fails CLOSED.
        let mut broken_block = conditioned(
            "broken",
            0,
            Action::Block,
            r#"[{"target":"body","operator":"regex","value":"("}]"#,
        );
        broken_block.targets = secret_target();
        let rules = vec![broken_block, rule("open", 1, Action::Allow)];
        match evaluate_outcome(
            &[],
            &rules,
            &request(),
            &no_principals(),
            &body_input(b"anything"),
        ) {
            Outcome::Rule(r) => assert_eq!(r.id, "broken", "Block must fail closed"),
            _ => panic!("expected the broken-condition block"),
        }
    }

    #[test]
    fn header_condition_narrows_a_v2_rule() {
        let rules = vec![
            conditioned(
                "hdr",
                0,
                Action::Block,
                r#"[{"target":"header","operator":"equals","key":"X-Env","value":"prod"}]"#,
            ),
            rule("open", 1, Action::Allow),
        ];
        let mut headers = hyper::HeaderMap::new();
        headers.insert("x-env", hyper::header::HeaderValue::from_static("prod"));
        let input = MatchInput {
            body: None,
            body_truncated: false,
            headers: Some(&headers),
        };
        match evaluate_outcome(&[], &rules, &request(), &no_principals(), &input) {
            Outcome::Rule(r) => assert_eq!(r.id, "hdr", "matching header must block"),
            _ => panic!("expected the header-conditioned block"),
        }
        let mut other = hyper::HeaderMap::new();
        other.insert("x-env", hyper::header::HeaderValue::from_static("dev"));
        let input = MatchInput {
            body: None,
            body_truncated: false,
            headers: Some(&other),
        };
        match evaluate_outcome(&[], &rules, &request(), &no_principals(), &input) {
            Outcome::Rule(r) => assert_eq!(r.id, "open", "non-matching header falls through"),
            _ => panic!("expected the allow"),
        }
    }

    // ── Test #7: connection winner-binding, fail-closed both ways ───────

    /// A `Connection` target matches iff (winner == its id) AND the catalog
    /// fan-out hits — for an ALLOW and a BLOCK alike; no winner → never matches.
    #[test]
    fn connection_target_binds_to_the_winning_connection() {
        let conn_rule = |id: &str, action: Action| {
            let mut r = rule("c-rule", 1, action);
            r.targets = vec![Target::Connection {
                id: id.to_string(),
                provider: "gmail".to_string(),
                tools: Vec::new(),
            }];
            r
        };
        let req_via = |winner: Option<&str>| Request {
            host: "gmail.googleapis.com".to_string(),
            path: "/gmail/v1/users/me/messages".to_string(),
            method: "GET".to_string(),
            agent_id: "agent-1".to_string(),
            has_injections: true,
            is_llm_host: false,
            winning_connection_id: winner.map(str::to_string),
        };

        // BLOCK: matching winner binds; no winner → no match (fail-closed).
        let blk = vec![conn_rule("c1", Action::Block)];
        assert!(matches!(
            evaluate_outcome(&[], &blk, &req_via(Some("c1")), &no_principals(), &MatchInput::empty()),
            Outcome::Rule(r) if r.action == Action::Block
        ));
        assert!(matches!(
            evaluate_outcome(
                &[],
                &blk,
                &req_via(None),
                &no_principals(),
                &MatchInput::empty()
            ),
            Outcome::Allow
        ));
        // A same-provider sibling account → no match.
        assert!(matches!(
            evaluate_outcome(
                &[],
                &blk,
                &req_via(Some("c2")),
                &no_principals(),
                &MatchInput::empty()
            ),
            Outcome::Allow
        ));

        // ALLOW: an allow-connection rule over a project default-Block only
        // opens the door for its OWN winner; no winner → the default-Block
        // stands (fail-closed for allow too).
        let allow_over_block = vec![conn_rule("c1", Action::Allow), default_rule(Action::Block)];
        match evaluate_outcome(
            &[],
            &allow_over_block,
            &req_via(Some("c1")),
            &no_principals(),
            &MatchInput::empty(),
        ) {
            Outcome::Rule(r) => assert_eq!(r.action, Action::Allow),
            _ => panic!("winner should open its own connection allow"),
        }
        assert!(matches!(
            evaluate_outcome(
                &[],
                &allow_over_block,
                &req_via(None),
                &no_principals(),
                &MatchInput::empty()
            ),
            Outcome::DenyDefault(_)
        ));
    }

    // ── Test #1: an org-scope rule is enforced and attributed ───────────

    #[test]
    fn org_rule_is_enforced_and_carries_org_scope() {
        let org = vec![org_rule("org-block", 0, Action::Block)];
        match evaluate_outcome(
            &org,
            &[],
            &request(),
            &no_principals(),
            &MatchInput::empty(),
        ) {
            Outcome::Rule(r) => {
                assert_eq!(r.id, "org-block");
                assert_eq!(r.scope, RuleScope::Organization);
            }
            _ => panic!("expected the org block"),
        }
    }

    // ── Tests #2/#3/#4: directory identities via the principal set ──────

    #[test]
    fn user_and_group_identities_match_via_the_principal_set() {
        for (id, identity) in [
            ("by-user", Identity::User("u-1".to_string())),
            ("by-group", Identity::Group("g-1".to_string())),
        ] {
            let mut scoped = org_rule(id, 0, Action::Block);
            scoped.identities = vec![identity];
            let org = vec![scoped];
            // Present in the principal set → the rule matches.
            match evaluate_outcome(&org, &[], &request(), &principals(), &MatchInput::empty()) {
                Outcome::Rule(r) => assert_eq!(r.id, id),
                _ => panic!("expected {id} to match via principals"),
            }
            // Absent (empty/stale set) → the rule narrows to nothing.
            assert!(matches!(
                evaluate_outcome(
                    &org,
                    &[],
                    &request(),
                    &no_principals(),
                    &MatchInput::empty()
                ),
                Outcome::Allow
            ));
        }
    }

    /// Test #4: cross-org isolation at the match boundary — a rule naming a
    /// principal absent from THIS connection's set (it belongs to another org's
    /// directory, so the org-fenced loader never put it here) never matches.
    #[test]
    fn a_principal_outside_the_resolved_set_never_matches() {
        let mut foreign_user = org_rule("foreign-user", 0, Action::Block);
        foreign_user.identities = vec![Identity::User("u-other".to_string())];
        let mut foreign_group = org_rule("foreign-group", 1, Action::Block);
        foreign_group.identities = vec![Identity::Group("g-other".to_string())];
        let org = vec![foreign_user, foreign_group];
        assert!(matches!(
            evaluate_outcome(&org, &[], &request(), &principals(), &MatchInput::empty()),
            Outcome::Allow
        ));
    }

    // ── Test #5: EMPTY-ORG FAIL-OPEN ────────────────────────────────────

    /// An empty org slice must contribute NO verdict — never a phantom block.
    /// Most orgs have zero org rules (the boot converter writes project-scope
    /// only), so this is the load-bearing safety property.
    #[test]
    fn empty_org_fails_open_not_closed() {
        // No project rules either → plain allow, even credentialed.
        assert!(matches!(
            evaluate_outcome(
                &[],
                &[],
                &injected_request(),
                &no_principals(),
                &MatchInput::empty()
            ),
            Outcome::Allow
        ));
        // An empty org slice changes nothing vs the project-only walk.
        let project = vec![rule("open", 0, Action::Allow), default_rule(Action::Block)];
        match evaluate_outcome(
            &[],
            &project,
            &injected_request(),
            &no_principals(),
            &MatchInput::empty(),
        ) {
            Outcome::Rule(r) => assert_eq!(r.id, "open"),
            _ => panic!("expected the project allow, not a phantom org block"),
        }
    }

    // ── Test #6: empty project → the org level decides ──────────────────

    #[test]
    fn empty_project_lets_the_org_level_decide() {
        let org = vec![org_rule("org-allow", 0, Action::Allow)];
        match evaluate_outcome(
            &org,
            &[],
            &request(),
            &no_principals(),
            &MatchInput::empty(),
        ) {
            Outcome::Rule(r) => {
                assert_eq!(r.id, "org-allow");
                assert_eq!(r.scope, RuleScope::Organization);
            }
            _ => panic!("expected the org allow to decide"),
        }
        // An org default-Block over an empty project blocks under the carve.
        let org = vec![org_default(Action::Block)];
        match evaluate_outcome(
            &org,
            &[],
            &injected_request(),
            &no_principals(),
            &MatchInput::empty(),
        ) {
            Outcome::DenyDefault(d) => assert_eq!(d.scope, RuleScope::Organization),
            _ => panic!("expected the org deny-default"),
        }
    }

    // ── Test #8: two-level stricter-wins ────────────────────────────────

    #[test]
    fn org_block_overrides_project_allow_and_vice_versa() {
        // Org guardrail Block beats a project allow…
        let org = vec![org_rule("org-block", 0, Action::Block)];
        let project = vec![rule("proj-allow", 0, Action::Allow)];
        match evaluate_outcome(
            &org,
            &project,
            &request(),
            &no_principals(),
            &MatchInput::empty(),
        ) {
            Outcome::Rule(r) => assert_eq!(r.id, "org-block"),
            _ => panic!("expected the org block"),
        }
        // …and symmetrically a project Block survives an org allow.
        let org = vec![org_rule("org-allow", 0, Action::Allow)];
        let project = vec![rule("proj-block", 0, Action::Block)];
        match evaluate_outcome(
            &org,
            &project,
            &request(),
            &no_principals(),
            &MatchInput::empty(),
        ) {
            Outcome::Rule(r) => assert_eq!(r.id, "proj-block"),
            _ => panic!("expected the project block"),
        }
    }

    #[test]
    fn org_approval_beats_project_rate_limit() {
        let org = vec![{
            let mut r = approval_rule("org-approval", 0);
            r.scope = RuleScope::Organization;
            r
        }];
        let project = vec![rate_rule("proj-rate", 0)];
        match evaluate_outcome(
            &org,
            &project,
            &request(),
            &no_principals(),
            &MatchInput::empty(),
        ) {
            Outcome::Rule(r) => assert_eq!(r.id, "org-approval"),
            _ => panic!("expected the approval to outrank the rate limit"),
        }
    }

    #[test]
    fn equal_rank_rate_limits_attribute_to_the_org_rule() {
        // Two rate verdicts: only the winner acts, and the equal-rank tie goes
        // to org (left bias).
        let org = vec![{
            let mut r = rate_rule("org-rate", 0);
            r.scope = RuleScope::Organization;
            r
        }];
        let project = vec![rate_rule("proj-rate", 0)];
        match evaluate_outcome(
            &org,
            &project,
            &request(),
            &no_principals(),
            &MatchInput::empty(),
        ) {
            Outcome::Rule(r) => {
                assert_eq!(r.id, "org-rate");
                assert_eq!(r.scope, RuleScope::Organization);
            }
            _ => panic!("expected the org rate rule"),
        }
    }

    /// Test #11 (part): a level's `Other`-only rule is inert, the empty-identity
    /// rule at that level still fires, and both levels honor "any".
    #[test]
    fn empty_identities_match_any_at_both_levels_and_other_never_does() {
        let mut malformed = org_rule("malformed", 0, Action::Block);
        malformed.identities = vec![Identity::Other];
        let org = vec![malformed, org_rule("org-any", 1, Action::Block)];
        let project = vec![rule("proj-any", 0, Action::Allow)];
        match evaluate_outcome(
            &org,
            &project,
            &request(),
            &principals(),
            &MatchInput::empty(),
        ) {
            Outcome::Rule(r) => assert_eq!(r.id, "org-any"),
            _ => panic!("expected the any-identity org block"),
        }
    }

    // ── Test #9: the HARD FLOOR, both directions ────────────────────────

    /// A lone project ALLOW cannot open the org default-Block; a lone org ALLOW
    /// cannot open the project allowlist default-Block. Under the carve both
    /// fall through to the respective deny-default.
    #[test]
    fn a_lone_allow_cannot_open_the_other_levels_default_block() {
        // Direction 1: org default-Block + lone project allow → org deny-default.
        let org = vec![org_default(Action::Block)];
        let project = vec![rule("proj-allow", 0, Action::Allow)];
        match evaluate_outcome(
            &org,
            &project,
            &injected_request(),
            &no_principals(),
            &MatchInput::empty(),
        ) {
            Outcome::DenyDefault(d) => {
                assert!(d.is_default);
                assert_eq!(d.scope, RuleScope::Organization);
            }
            _ => panic!("the project allow must not punch the org floor"),
        }
        // Without the carve the org level allows — the project allow wins.
        match evaluate_outcome(
            &org,
            &project,
            &request(),
            &no_principals(),
            &MatchInput::empty(),
        ) {
            Outcome::Rule(r) => assert_eq!(r.id, "proj-allow"),
            _ => panic!("expected the project allow off the carve"),
        }

        // Direction 2: project default-Block (allowlist) + lone org allow →
        // project deny-default.
        let org = vec![org_rule("org-allow", 0, Action::Allow)];
        let project = vec![default_rule(Action::Block)];
        match evaluate_outcome(
            &org,
            &project,
            &injected_request(),
            &no_principals(),
            &MatchInput::empty(),
        ) {
            Outcome::DenyDefault(d) => {
                assert!(d.is_default);
                assert_eq!(d.scope, RuleScope::Project);
            }
            _ => panic!("the org allow must not punch the project allowlist floor"),
        }
        // Without the carve the project level allows — the org allow wins.
        match evaluate_outcome(
            &org,
            &project,
            &request(),
            &no_principals(),
            &MatchInput::empty(),
        ) {
            Outcome::Rule(r) => assert_eq!(r.id, "org-allow"),
            _ => panic!("expected the org allow off the carve"),
        }
    }

    /// The counter-case: a BLOCK is never dropped by the floor logic (it only
    /// tightens), and an allow-posture opposite level lets the allow through.
    #[test]
    fn a_block_survives_the_floor_and_an_allow_posture_lets_an_allow_win() {
        // A project BLOCK applies even against an org default-Block…
        let org = vec![org_default(Action::Block)];
        let project = vec![rule("proj-block", 0, Action::Block)];
        match evaluate_outcome(
            &org,
            &project,
            &injected_request(),
            &no_principals(),
            &MatchInput::empty(),
        ) {
            Outcome::Rule(r) => assert_eq!(r.id, "proj-block"),
            _ => panic!("a block must survive the org floor"),
        }
        // …and with no org default-Block a lone org allow just wins.
        let org = vec![org_rule("org-allow", 0, Action::Allow)];
        match evaluate_outcome(
            &org,
            &[],
            &injected_request(),
            &no_principals(),
            &MatchInput::empty(),
        ) {
            Outcome::Rule(r) => assert_eq!(r.id, "org-allow"),
            _ => panic!("expected the org allow"),
        }
    }

    // ── Test #10: deny-default carve per level ──────────────────────────

    #[test]
    fn org_default_block_carve_gates_each_level_independently() {
        // Org default-Block: spared off the carve, blocks under it.
        let org = vec![org_default(Action::Block)];
        assert!(matches!(
            evaluate_outcome(
                &org,
                &[],
                &request(),
                &no_principals(),
                &MatchInput::empty()
            ),
            Outcome::Allow
        ));
        match evaluate_outcome(
            &org,
            &[],
            &injected_request(),
            &no_principals(),
            &MatchInput::empty(),
        ) {
            Outcome::DenyDefault(d) => assert_eq!(d.scope, RuleScope::Organization),
            _ => panic!("expected the org deny-default under the carve"),
        }
        // Project default-Block: same carve, independently.
        let project = vec![default_rule(Action::Block)];
        assert!(matches!(
            evaluate_outcome(
                &[],
                &project,
                &request(),
                &no_principals(),
                &MatchInput::empty()
            ),
            Outcome::Allow
        ));
        match evaluate_outcome(
            &[],
            &project,
            &injected_request(),
            &no_principals(),
            &MatchInput::empty(),
        ) {
            Outcome::DenyDefault(d) => assert_eq!(d.scope, RuleScope::Project),
            _ => panic!("expected the project deny-default under the carve"),
        }
    }

    #[test]
    fn absent_project_default_with_org_default_allow_is_allow() {
        let org = vec![org_default(Action::Allow)];
        assert!(matches!(
            evaluate_outcome(
                &org,
                &[],
                &injected_request(),
                &no_principals(),
                &MatchInput::empty()
            ),
            Outcome::Allow
        ));
    }

    #[test]
    fn rate_window_secs_mapping() {
        assert_eq!(RateWindow::Minute.secs(), 60);
        assert_eq!(RateWindow::Hour.secs(), 3600);
        assert_eq!(RateWindow::Day.secs(), 86400);
    }
}
