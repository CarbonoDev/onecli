//! OSS body/header condition matching (Tier 3a).
//!
//! A rule's `conditions` JSON (validated server-side as `RuleCondition[]`)
//! further narrows when the rule applies: every condition must hold (AND —
//! exactly like `method` + `path_pattern` already AND together). Two targets:
//!
//! - `body`: a raw byte-level match over the fully buffered request body
//!   (`contains` / `equals` / `regex` via `regex::bytes` — linear-time, no
//!   ReDoS, no lossy UTF-8 conversion so binary bodies can't dodge a needle).
//! - `header`: matched against the request headers. Header NAMES are
//!   case-insensitive (RFC 9110, free with `HeaderMap`); header VALUES are
//!   compared case-sensitively on raw bytes (`(?i)` regex serves the
//!   case-insensitive cases); any value of a multi-value header satisfies the
//!   condition. `exists` (header-only) needs at least one value present.
//!
//! ## Failure law (SECURITY)
//!
//! A condition that cannot be evaluated — malformed JSON, unknown
//! target/operator, missing required value/key, an uncompilable regex, or a
//! body that exceeded the buffer cap — must never weaken enforcement:
//! the rule MATCHES if it is a Block rule (over-block, fail-closed) and does
//! NOT match otherwise (an Allow-family rule falls through to the next rule /
//! the Default Rule instead of silently widening). The v2 engine routes its
//! rules through here via pseudo-rules that carry the owning rule's Block
//! action for exactly this reason (see `policy_engine/evaluate.rs`).
//!
//! A rule's `conditions` may also be a JSON OBJECT — a connection target's
//! granular session policy (`{repositories: […]}` / `{folders: […]}`), not a
//! behavioral condition. Those are vacuous here (Tier 3b's `granular_access`
//! concern), matching the server-side `isSessionPolicy` discriminator.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use hyper::body::Bytes;
use hyper::header::{HeaderName, HeaderValue};
use tracing::{debug, warn};

use crate::policy::{BodyCapture, MatchInput, PolicyAction, PolicyRule};

/// Maximum request body buffered for condition matching. A larger body is
/// forwarded intact but becomes unevaluable for body conditions (→ the
/// failure law: Block rules over-block, Allow rules fall through). No
/// prefix-only matching — an attacker could push the needle past any prefix.
pub(crate) const CONDITION_BODY_CAP: usize = 256 * 1024;

/// One decoded behavioral condition (the server-validated `RuleCondition`
/// shape). Unknown FIELDS fail to decode (`deny_unknown_fields`) and unknown
/// target/operator VALUES decode but evaluate to `Invalid` — both route
/// through the fail-closed law, so a NEWER authoring surface (say, a future
/// `negate` flag) can never silently widen an older gateway.
#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RuleCondition {
    target: String,
    operator: String,
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    key: Option<String>,
}

/// Three-state condition evaluation. `Invalid` = unevaluable, routed through
/// the failure law.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CondEval {
    Match,
    NoMatch,
    Invalid,
}

/// The decoded shape of a rule's `conditions` JSON.
enum DecodedConditions {
    /// None / session-policy object / empty array → no behavioral conditions.
    Vacuous,
    /// A behavioral array; each element decoded independently so one malformed
    /// element poisons only itself (→ `Invalid`), not its siblings.
    Behavioral(Vec<Result<RuleCondition, ()>>),
}

fn decode_conditions(raw: &Option<serde_json::Value>) -> DecodedConditions {
    match raw {
        None => DecodedConditions::Vacuous,
        // An object is a connection target's granular session policy
        // (`repositories`/`folders`) — scoping, not a behavioral condition.
        Some(serde_json::Value::Object(_)) => DecodedConditions::Vacuous,
        Some(serde_json::Value::Array(items)) if items.is_empty() => DecodedConditions::Vacuous,
        Some(serde_json::Value::Array(items)) => DecodedConditions::Behavioral(
            items
                .iter()
                .map(|item| serde_json::from_value::<RuleCondition>(item.clone()).map_err(|_| ()))
                .collect(),
        ),
        // Any other JSON shape is malformed → one unevaluable condition.
        Some(_) => DecodedConditions::Behavioral(vec![Err(())]),
    }
}

/// Whether a rule's `conditions` JSON contains at least one BODY condition —
/// the buffering predicate's core. Header-only conditions never buffer
/// (headers are always available). Elements that fail to decode do NOT count:
/// they evaluate to `Invalid` regardless of body content, so the body is
/// never needed to decide them.
pub(crate) fn has_body_condition(raw: &Option<serde_json::Value>) -> bool {
    match decode_conditions(raw) {
        DecodedConditions::Vacuous => false,
        DecodedConditions::Behavioral(conds) => conds
            .iter()
            .any(|c| matches!(c, Ok(cond) if cond.target == "body")),
    }
}

/// True iff any rule carries a body condition. Header conditions do not trigger
/// buffering. Kept for API symmetry and unit tests; the v2 forward path uses
/// the host-scoped `policy_engine::needs_body_buffer` instead.
#[allow(dead_code)]
pub(crate) fn needs_body_buffer(rules: &[PolicyRule]) -> bool {
    rules.iter().any(|r| has_body_condition(&r.conditions_raw))
}

// ── Evaluation ──────────────────────────────────────────────────────────

/// Byte-substring search (an empty needle matches anything). Linear-time
/// (`memchr::memmem`) — the haystack is an attacker-controlled request body,
/// so a naive O(haystack × needle) scan would be a cheap CPU-DoS amplifier.
fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    memchr::memmem::find(haystack, needle).is_some()
}

/// Compiled-program cap per pattern (1 MiB — ample for the API's 1000-char
/// patterns). The crate default is 10 MiB, which would let a rule author pin
/// gigabytes of compiled programs in the process-wide cache via nested
/// repetitions; an over-limit pattern fails to compile and routes through the
/// existing `Invalid` fail-closed path.
const REGEX_SIZE_LIMIT: usize = 1 << 20;

fn compile_regex(pattern: &str) -> Option<regex::bytes::Regex> {
    regex::bytes::RegexBuilder::new(pattern)
        .size_limit(REGEX_SIZE_LIMIT)
        .build()
        .ok()
}

/// Compile (or fetch) a `regex::bytes` pattern through a bounded process-wide
/// cache; `None` caches a compile failure so a broken pattern doesn't
/// recompile per request. On cache overflow, compile uncached (correctness
/// identical, just slower).
fn compiled_regex(pattern: &str) -> Option<regex::bytes::Regex> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<regex::bytes::Regex>>>> = OnceLock::new();
    const CACHE_CAP: usize = 256;
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut map) = cache.lock() {
        if let Some(cached) = map.get(pattern) {
            return cached.clone();
        }
        let compiled = compile_regex(pattern);
        if map.len() < CACHE_CAP {
            map.insert(pattern.to_string(), compiled.clone());
        }
        return compiled;
    }
    compile_regex(pattern)
}

/// Apply a value operator (`contains`/`equals`/`regex`) over raw bytes.
fn eval_operator(operator: &str, haystack: &[u8], value: &str) -> CondEval {
    match operator {
        "contains" => {
            if contains_bytes(haystack, value.as_bytes()) {
                CondEval::Match
            } else {
                CondEval::NoMatch
            }
        }
        "equals" => {
            if haystack == value.as_bytes() {
                CondEval::Match
            } else {
                CondEval::NoMatch
            }
        }
        "regex" => match compiled_regex(value) {
            Some(re) if re.is_match(haystack) => CondEval::Match,
            Some(_) => CondEval::NoMatch,
            None => CondEval::Invalid,
        },
        _ => CondEval::Invalid,
    }
}

fn eval_body_condition(cond: &RuleCondition, input: &MatchInput<'_>) -> CondEval {
    // `exists` is header-only ("has a body" is not a meaningful policy).
    if cond.operator == "exists" {
        return CondEval::Invalid;
    }
    // Over-cap body: unevaluable (never a prefix match — see the module doc).
    if input.body_truncated {
        return CondEval::Invalid;
    }
    let Some(value) = cond.value.as_deref() else {
        return CondEval::Invalid;
    };
    // Absent body is a FACT, not a failure: `needs_body_buffer` is a superset
    // of "a body condition could be consulted", so `None` here genuinely means
    // the request had no body (GETs, WS upgrades) → match against empty.
    let body = input.body.unwrap_or(&[]);
    eval_operator(&cond.operator, body, value)
}

fn eval_header_condition(cond: &RuleCondition, input: &MatchInput<'_>) -> CondEval {
    let Some(key) = cond.key.as_deref().filter(|k| !k.trim().is_empty()) else {
        return CondEval::Invalid;
    };
    // Header-name lookup is case-insensitive via HeaderMap; a name that isn't
    // a valid header name can never have been sent → unevaluable.
    let Ok(name) = HeaderName::from_bytes(key.as_bytes()) else {
        return CondEval::Invalid;
    };
    let values: Vec<&HeaderValue> = match input.headers {
        Some(headers) => headers.get_all(&name).iter().collect(),
        None => Vec::new(),
    };
    if cond.operator == "exists" {
        return if values.is_empty() {
            CondEval::NoMatch
        } else {
            CondEval::Match
        };
    }
    let Some(value) = cond.value.as_deref() else {
        return CondEval::Invalid;
    };
    // Any value of a multi-value header satisfies the condition; values are
    // compared case-sensitively on raw bytes (`(?i)` regex for insensitive).
    let mut result = CondEval::NoMatch;
    for v in values {
        match eval_operator(&cond.operator, v.as_bytes(), value) {
            CondEval::Match => return CondEval::Match,
            CondEval::Invalid => return CondEval::Invalid,
            CondEval::NoMatch => result = CondEval::NoMatch,
        }
    }
    result
}

fn eval_condition(cond: &RuleCondition, input: &MatchInput<'_>) -> CondEval {
    match cond.target.as_str() {
        // `key` on a body condition is accepted-but-ignored (reserved; a
        // JSON-path narrowing could use it later without breaking anything).
        "body" => eval_body_condition(cond, input),
        "header" => eval_header_condition(cond, input),
        _ => CondEval::Invalid,
    }
}

/// Warn ONCE per rule name that a condition is unevaluable (a stored broken
/// rule would otherwise log per request — per pseudo-rule variant on tool
/// fan-outs — and flood a busy host); repeats land at `debug!`. The seen-set
/// is bounded: past the cap, new names also log at debug (never unbounded
/// memory for log bookkeeping).
fn log_unevaluable(rule_name: &str, is_block: bool) {
    use std::collections::HashSet;
    static SEEN: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    const SEEN_CAP: usize = 1024;
    let first = SEEN
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .map(|mut seen| {
            !seen.contains(rule_name) && seen.len() < SEEN_CAP && seen.insert(rule_name.to_string())
        })
        .unwrap_or(true);
    let outcome = if is_block {
        "failing closed (rule matches)"
    } else {
        "rule falls through"
    };
    if first {
        warn!(rule = %rule_name, is_block, "policy: unevaluable rule condition — {outcome}");
    } else {
        debug!(rule = %rule_name, is_block, "policy: unevaluable rule condition — {outcome}");
    }
}

/// Does the rule's condition set hold for this request? Vacuously true without
/// behavioral conditions; else ALL conditions must match (AND). Any
/// unevaluable condition applies the failure law: the rule matches iff it is
/// a Block rule (see the module doc).
pub(crate) fn matches(rule: &PolicyRule, input: &MatchInput<'_>) -> bool {
    let conds = match decode_conditions(&rule.conditions_raw) {
        DecodedConditions::Vacuous => return true,
        DecodedConditions::Behavioral(conds) => conds,
    };
    let mut all_match = true;
    for cond in &conds {
        let eval = match cond {
            Ok(cond) => eval_condition(cond, input),
            Err(()) => CondEval::Invalid,
        };
        match eval {
            CondEval::Match => {}
            CondEval::NoMatch => all_match = false,
            CondEval::Invalid => {
                let is_block = matches!(rule.action, PolicyAction::Block);
                log_unevaluable(&rule.name, is_block);
                return is_block;
            }
        }
    }
    all_match
}

// ── Body buffering ──────────────────────────────────────────────────────

/// What `buffer_up_to` produced: either the complete body, or the buffered
/// prefix plus the UNREAD remainder of the stream.
enum BufferOutcome<B> {
    /// The body ended within the cap — these are ALL its bytes.
    Complete(Vec<u8>),
    /// The cap was exceeded: the prefix read so far (cap+ε — frame-granular)
    /// and the rest of the body, still unread.
    Exceeded(Vec<u8>, B),
}

/// Accumulate DATA frames until the body ends or the cap is exceeded.
/// Trailers are dropped when the body completes within the cap — the same
/// pre-existing posture as the fully-buffered default-interception branch in
/// forward.rs (HTTP/1 chunked trailers are vanishingly rare on API traffic).
async fn buffer_up_to<B>(mut body: B, cap: usize) -> anyhow::Result<BufferOutcome<B>>
where
    B: hyper::body::Body<Data = Bytes> + Unpin,
    B::Error: std::error::Error + Send + Sync + 'static,
{
    use http_body_util::BodyExt;
    let mut buffered: Vec<u8> = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(anyhow::Error::new)?;
        if let Ok(data) = frame.into_data() {
            buffered.extend_from_slice(&data);
            if buffered.len() > cap {
                return Ok(BufferOutcome::Exceeded(buffered, body));
            }
        }
    }
    Ok(BufferOutcome::Complete(buffered))
}

/// The forward stream for an over-cap body: the buffered prefix first, then
/// the remaining frames relayed one by one (never collected — the tail may be
/// arbitrarily large), so the upstream receives EXACTLY the original bytes.
fn forward_stream<B>(
    prefix: Vec<u8>,
    rest: B,
) -> impl futures_util::Stream<Item = std::io::Result<Bytes>>
where
    B: hyper::body::Body<Data = Bytes> + Unpin,
    B::Error: std::error::Error + Send + Sync + 'static,
{
    use futures_util::{StreamExt, TryStreamExt};
    let head = futures_util::stream::iter(std::iter::once(Ok(Bytes::from(prefix))));
    let tail =
        http_body_util::BodyDataStream::new(rest).map_err(|e| std::io::Error::other(e.to_string()));
    head.chain(tail)
}

/// Buffer the request body for condition matching and rebuild the forwarding
/// body. MITM correctness: the upstream always receives the original bytes —
/// a within-cap body forwards the exact buffered bytes; an over-cap body
/// forwards the buffered prefix chained with the untouched remaining stream
/// (and captures `Truncated`, which the matcher treats as unevaluable).
pub(crate) async fn prepare_body(
    body: hyper::body::Incoming,
    _method: &str,
    _url: &str,
) -> anyhow::Result<(BodyCapture, reqwest::Body)> {
    match buffer_up_to(body, CONDITION_BODY_CAP).await? {
        BufferOutcome::Complete(bytes) => {
            let fwd = reqwest::Body::from(bytes.clone());
            Ok((BodyCapture::Full(bytes), fwd))
        }
        BufferOutcome::Exceeded(prefix, rest) => {
            let fwd = reqwest::Body::wrap_stream(forward_stream(prefix.clone(), rest));
            Ok((BodyCapture::Truncated(prefix), fwd))
        }
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(action: PolicyAction, conditions: &str) -> PolicyRule {
        PolicyRule {
            name: "Conditioned rule".to_string(),
            path_pattern: "*".to_string(),
            method: None,
            action,
            conditions_raw: Some(serde_json::from_str(conditions).expect("conditions JSON")),
        }
    }

    fn block(conditions: &str) -> PolicyRule {
        rule(PolicyAction::Block, conditions)
    }

    fn allow(conditions: &str) -> PolicyRule {
        rule(PolicyAction::Allow, conditions)
    }

    fn with_body(body: &[u8]) -> MatchInput<'_> {
        MatchInput {
            body: Some(body),
            body_truncated: false,
            headers: None,
        }
    }

    fn headers(pairs: &[(&str, &str)]) -> hyper::HeaderMap {
        let mut map = hyper::HeaderMap::new();
        for (name, value) in pairs {
            map.append(
                HeaderName::from_bytes(name.as_bytes()).expect("header name"),
                HeaderValue::from_str(value).expect("header value"),
            );
        }
        map
    }

    fn with_headers(map: &hyper::HeaderMap) -> MatchInput<'_> {
        MatchInput {
            body: None,
            body_truncated: false,
            headers: Some(map),
        }
    }

    // ── Decode + vacuous shapes ─────────────────────────────────────────

    #[test]
    fn no_conditions_is_vacuous() {
        let mut none = block(r#"[]"#);
        none.conditions_raw = None;
        let empty = block(r#"[]"#);
        // A session-policy OBJECT is granular scoping, not behavioral — must
        // stay vacuous or every granular allow rule would stop matching.
        let session = block(r#"{"repositories":["owner/repo"]}"#);
        for r in [&none, &empty, &session] {
            assert!(matches(r, &MatchInput::empty()));
            assert!(!needs_body_buffer(std::slice::from_ref(r)));
        }
    }

    // ── Body operators ──────────────────────────────────────────────────

    #[test]
    fn body_contains_matches_and_falls_through() {
        let r = block(r#"[{"target":"body","operator":"contains","value":"needle"}]"#);
        assert!(matches(&r, &with_body(b"hay needle stack")));
        assert!(!matches(&r, &with_body(b"just hay")));
    }

    #[test]
    fn body_equals_and_regex_match() {
        let eq = block(r#"[{"target":"body","operator":"equals","value":"exact"}]"#);
        assert!(matches(&eq, &with_body(b"exact")));
        assert!(!matches(&eq, &with_body(b"exact-not")));

        let re = allow(r#"[{"target":"body","operator":"regex","value":"(?i)delete\\s+repo"}]"#);
        assert!(matches(&re, &with_body(b"please DELETE repo now")));
        assert!(!matches(&re, &with_body(b"read repo")));

        // Raw-byte matching: a needle inside a binary body still matches.
        let bin = block(r#"[{"target":"body","operator":"contains","value":"secret"}]"#);
        let mut body = vec![0xFF, 0xFE, 0x00];
        body.extend_from_slice(b"secret");
        body.push(0x80);
        assert!(matches(&bin, &with_body(&body)));
    }

    #[test]
    fn conditions_are_anded() {
        let r = block(
            r#"[{"target":"body","operator":"contains","value":"alpha"},
                {"target":"body","operator":"contains","value":"beta"}]"#,
        );
        assert!(matches(&r, &with_body(b"alpha and beta")));
        assert!(!matches(&r, &with_body(b"alpha only")));
    }

    // ── Header conditions ───────────────────────────────────────────────

    #[test]
    fn header_name_lookup_is_case_insensitive() {
        let r = block(r#"[{"target":"header","operator":"equals","key":"X-Foo","value":"bar"}]"#);
        let map = headers(&[("x-foo", "bar")]);
        assert!(matches(&r, &with_headers(&map)));
    }

    #[test]
    fn header_operators() {
        let map = headers(&[("x-multi", "first"), ("x-multi", "second-value")]);

        let eq = block(
            r#"[{"target":"header","operator":"equals","key":"x-multi","value":"second-value"}]"#,
        );
        assert!(matches(&eq, &with_headers(&map)), "any value satisfies");

        let contains =
            block(r#"[{"target":"header","operator":"contains","key":"x-multi","value":"econd"}]"#);
        assert!(matches(&contains, &with_headers(&map)));

        let re =
            block(r#"[{"target":"header","operator":"regex","key":"x-multi","value":"^SECOND"}]"#);
        // Values are case-SENSITIVE: an uppercase anchor misses…
        assert!(!matches(&re, &with_headers(&map)));
        // …and `(?i)` opts in to case-insensitive.
        let re_i = block(
            r#"[{"target":"header","operator":"regex","key":"x-multi","value":"(?i)^SECOND"}]"#,
        );
        assert!(matches(&re_i, &with_headers(&map)));

        let exists = block(r#"[{"target":"header","operator":"exists","key":"x-multi"}]"#);
        assert!(matches(&exists, &with_headers(&map)));

        // Missing header → NoMatch for every operator, exists included (an
        // ALLOW falls through AND a BLOCK falls through — absence is a fact).
        let missing_eq =
            block(r#"[{"target":"header","operator":"equals","key":"x-gone","value":"v"}]"#);
        assert!(!matches(&missing_eq, &with_headers(&map)));
        let missing_exists = block(r#"[{"target":"header","operator":"exists","key":"x-gone"}]"#);
        assert!(!matches(&missing_exists, &with_headers(&map)));
        // No headers at all behaves like the header being absent.
        assert!(!matches(&missing_exists, &MatchInput::empty()));
    }

    // ── Decision I: absent body is a fact, not a failure ────────────────

    #[test]
    fn absent_body_is_empty_not_invalid() {
        let r = block(r#"[{"target":"body","operator":"contains","value":"needle"}]"#);
        // Even a Block rule falls through: `needs_body_buffer` guarantees a
        // body-conditioned rule only ever sees `None` when there WAS no body.
        assert!(!matches(&r, &MatchInput::empty()));
        // But an operator satisfied by the empty body still matches.
        let empty_ok = block(r#"[{"target":"body","operator":"regex","value":"^$"}]"#);
        assert!(matches(&empty_ok, &MatchInput::empty()));
    }

    // ── Failure law (Decisions H + J) ───────────────────────────────────

    #[test]
    fn truncated_body_fails_closed_for_block_and_open_for_allow() {
        let cond = r#"[{"target":"body","operator":"contains","value":"needle"}]"#;
        let truncated = MatchInput {
            body: None,
            body_truncated: true,
            headers: None,
        };
        assert!(matches(&block(cond), &truncated), "Block must over-block");
        assert!(
            !matches(&allow(cond), &truncated),
            "Allow must fall through"
        );
        let approval = rule(
            PolicyAction::ManualApproval {
                rule_id: "r1".to_string(),
            },
            cond,
        );
        assert!(!matches(&approval, &truncated));
        let rate = rule(
            PolicyAction::RateLimit {
                rule_id: "r1".to_string(),
                max_requests: 5,
                window_secs: 60,
            },
            cond,
        );
        assert!(!matches(&rate, &truncated));
    }

    #[test]
    fn malformed_condition_json_fails_closed_by_action() {
        for cond in [
            r#"[42]"#,                                                     // garbage element
            r#"[{"target":"body","operator":"telepathy","value":"x"}]"#,   // unknown operator
            r#"[{"target":"cookies","operator":"contains","value":"x"}]"#, // unknown target
            r#"[{"target":"body","operator":"contains"}]"#,                // missing value
            r#"[{"target":"header","operator":"equals","value":"x"}]"#,    // header w/o key
            r#"[{"target":"header","operator":"equals","key":"bad name","value":"x"}]"#,
            r#"[{"target":"body","operator":"exists"}]"#, // exists on body
            // Unknown field: a future narrowing/inverting flag (e.g. `negate`)
            // must fail decode, not silently drop and widen matching.
            r#"[{"target":"body","operator":"contains","value":"x","negate":true}]"#,
            r#""nonsense""#, // non-array/object
        ] {
            assert!(matches(&block(cond), &with_body(b"body")), "{cond}");
            assert!(!matches(&allow(cond), &with_body(b"body")), "{cond}");
        }
    }

    #[test]
    fn uncompilable_regex_fails_closed_for_block() {
        // The headline security case: a Block whose regex Rust rejects (JS
        // lookbehind) must BLOCK, never silently fall through.
        let cond = r#"[{"target":"body","operator":"regex","value":"(?<=x)y["}]"#;
        assert!(matches(&block(cond), &with_body(b"anything")));
        assert!(!matches(&allow(cond), &with_body(b"anything")));
    }

    #[test]
    fn oversized_regex_program_fails_closed() {
        // Nested repetitions can approach the compiler's size limit; capping
        // it at `REGEX_SIZE_LIMIT` (instead of the 10 MiB default) keeps a
        // rule author from pinning gigabytes of compiled programs in the
        // process-wide cache. Over-limit patterns fail to compile → the
        // Invalid fail-closed path.
        assert!(compile_regex("(?:x{1000}){1000}").is_none(), "over the cap");
        assert!(compile_regex("(?i)delete\\s+repo").is_some(), "normal");
        let cond = r#"[{"target":"body","operator":"regex","value":"(?:x{1000}){1000}"}]"#;
        assert!(matches(&block(cond), &with_body(b"x")));
        assert!(!matches(&allow(cond), &with_body(b"x")));
    }

    // ── Buffering predicate ─────────────────────────────────────────────

    #[test]
    fn needs_body_buffer_only_for_body_conditions() {
        let header_only = block(r#"[{"target":"header","operator":"exists","key":"x-api-key"}]"#);
        assert!(!needs_body_buffer(&[header_only]));
        let body = block(r#"[{"target":"body","operator":"contains","value":"x"}]"#);
        assert!(needs_body_buffer(&[body]));
        let unconditioned = PolicyRule {
            name: "plain".to_string(),
            path_pattern: "*".to_string(),
            method: None,
            action: PolicyAction::Block,
            conditions_raw: None,
        };
        assert!(!needs_body_buffer(&[unconditioned]));
        assert!(!needs_body_buffer(&[]));
    }

    // ── prepare_body / buffer_up_to (MITM correctness) ──────────────────

    #[tokio::test]
    async fn buffer_with_cap_returns_exact_bytes_and_forwards_them_intact() {
        use http_body_util::Full;
        let payload = b"{\"content\":\"hello world\"}".to_vec();
        let body = Full::new(Bytes::from(payload.clone()));
        let BufferOutcome::Complete(captured) = buffer_up_to(body, 1024).await.expect("buffer")
        else {
            panic!("within-cap body must buffer completely");
        };
        assert_eq!(captured, payload, "capture must be byte-identical");
        // The forwarded body is rebuilt from the same bytes (prepare_body's
        // Complete arm): byte-identical to the original.
        let fwd = reqwest::Body::from(captured.clone());
        assert_eq!(fwd.as_bytes(), Some(payload.as_slice()));
    }

    #[tokio::test]
    async fn buffer_with_cap_truncates_over_cap_and_still_forwards_everything() {
        use futures_util::TryStreamExt;
        use http_body_util::StreamBody;
        use hyper::body::Frame;

        // Three frames, 30 bytes total, cap 10 → the capture truncates after
        // the frame that crosses the cap; the upstream must still receive all
        // 30 original bytes in order.
        let frames: Vec<Result<Frame<Bytes>, std::convert::Infallible>> = vec![
            Ok(Frame::data(Bytes::from_static(b"0123456789"))),
            Ok(Frame::data(Bytes::from_static(b"abcdefghij"))),
            Ok(Frame::data(Bytes::from_static(b"ABCDEFGHIJ"))),
        ];
        let body = StreamBody::new(futures_util::stream::iter(frames));
        let BufferOutcome::Exceeded(prefix, rest) = buffer_up_to(body, 10).await.expect("buffer")
        else {
            panic!("over-cap body must report Exceeded");
        };
        assert_eq!(prefix, b"0123456789abcdefghij".to_vec(), "cap+ε prefix");

        // Draining the reconstructed forward stream yields the FULL original
        // byte sequence — nothing lost, nothing reordered.
        let forwarded: Vec<u8> = forward_stream(prefix.clone(), rest)
            .try_collect::<Vec<Bytes>>()
            .await
            .expect("drain forward stream")
            .concat();
        assert_eq!(forwarded, b"0123456789abcdefghijABCDEFGHIJ".to_vec());

        // And the capture is opaque to matching (only peekable).
        let capture = BodyCapture::Truncated(prefix.clone());
        assert_eq!(capture.bytes(), Some(prefix.as_slice()));
        assert_eq!(capture.bytes_for_matching(), None);
    }
}
