//! Shapes for the OSS policy core: the decoded rule, the request context, and
//! the evaluation outcome. Org + project scopes with agent and directory
//! (user/group) identities — granular conditions stay vacuous here; those live
//! in the EE engine this module replaces under `edition_oss`. There is no
//! agent-group concept: it was deleted, so no identity kind, principal column,
//! or loader references one.

/// The rule verdict: the v2 binary. Approval and rate limits are modifiers on
/// `Allow` (see `Rule`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Action {
    Allow,
    Block,
}

/// A rate-limit window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RateWindow {
    Minute,
    Hour,
    Day,
}

impl RateWindow {
    pub(super) fn secs(self) -> u64 {
        match self {
            RateWindow::Minute => 60,
            RateWindow::Hour => 3600,
            RateWindow::Day => 86400,
        }
    }
}

/// Which scope a decoded rule came from. Drives `MatchedRule.scope` (telemetry
/// attribution) and the org-first tie-break in the two-level evaluator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RuleScope {
    Organization,
    Project,
}

impl RuleScope {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            RuleScope::Organization => "organization",
            RuleScope::Project => "project",
        }
    }
}

/// A rule identity (empty identity list = "any"). `Agent` matches the acting
/// agent by id; the directory kinds (`User`/`Group`) match against the
/// connection's resolved `PrincipalSet`. `Other` covers a row naming NO
/// principal the OSS engine understands (malformed, or a future kind) — it
/// NEVER matches, so such a row narrows to nothing instead of silently
/// widening to "any" (fail-closed).
#[derive(Debug, Clone)]
pub(super) enum Identity {
    Agent(String),
    User(String),
    Group(String),
    Other,
}

/// A rule target. `Network` matches host/path/method verbatim; `App` names a
/// provider and tool set the catalog expands to its endpoint fan-out (empty
/// tools = the whole app, host-only); `Connection` binds one specific
/// connection — winner-id equality plus the same catalog expansion; `Secret`
/// gates its resolved host pattern(s); `Unresolved` is the fail-closed arm for
/// anything that cannot be resolved (unknown kind, provider-less app row, a
/// connection/secret id absent from the fenced connect-time maps) — it never
/// matches.
#[derive(Debug, Clone)]
pub(super) enum Target {
    Network {
        host_pattern: String,
        path_pattern: Option<String>,
        method: Option<String>,
    },
    App {
        provider: String,
        tools: Vec<String>,
    },
    /// Matches only when this is the request's winning injected connection AND
    /// the provider/tools fan-out hits; no winner → never matches (fail-closed
    /// for allow AND block).
    Connection {
        id: String,
        provider: String,
        tools: Vec<String>,
    },
    Secret {
        host_patterns: Vec<String>,
    },
    Unresolved,
}

/// A decoded rule the evaluator walks, tagged with the scope it came from.
#[derive(Debug, Clone)]
pub(super) struct Rule {
    pub id: String,
    /// The level (org guardrail vs project) this rule decides for.
    pub scope: RuleScope,
    /// Generation-stable identity — the shared rate counter keys on it, so the
    /// count survives republishes.
    pub logical_id: String,
    pub name: String,
    pub priority: usize,
    pub is_default: bool,
    pub identities: Vec<Identity>,
    pub targets: Vec<Target>,
    pub action: Action,
    pub require_approval: bool,
    pub rate_limit: Option<u64>,
    pub rate_limit_window: Option<RateWindow>,
    /// Carried for structural fidelity and routed through the edition-swapped
    /// `condition_match` — which is the no-op arm in OSS, so conditions are
    /// never evaluated here (matching the legacy OSS gateway exactly).
    pub conditions: Option<serde_json::Value>,
}

/// The request context one decision runs against. `host` is port-stripped by
/// the caller.
#[derive(Debug, Clone)]
pub(super) struct Request {
    pub host: String,
    pub path: String,
    pub method: String,
    pub agent_id: String,
    /// A credential was injected for this host — the deny-default precondition.
    pub has_injections: bool,
    /// Host is a known LLM provider — bypasses deny-default.
    pub is_llm_host: bool,
    /// The app connection that won injection for this request; `None` when no
    /// connection serves it. `Target::Connection` matches only against this id.
    pub winning_connection_id: Option<String>,
}

impl Request {
    /// The deny-default carve: only credentialed, non-LLM traffic can be
    /// blocked by a Default Rule. Mirrors `forward.rs`'s `enforce_deny`.
    pub(super) fn enforce_deny(&self) -> bool {
        self.has_injections && !self.is_llm_host
    }
}

/// The winning outcome of an evaluation: an explicit matching rule, a level's
/// Default Rule's enforced Block (carrying THAT rule, so telemetry can
/// attribute it — always concrete, never anonymous), or a plain allow.
pub(super) enum Outcome<'a> {
    Rule(&'a Rule),
    DenyDefault(&'a Rule),
    Allow,
}
