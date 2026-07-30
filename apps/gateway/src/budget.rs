//! Budget layer — spend caps on org/project-owned LLM secrets (OSS).
//!
//! An admin sets a per-secret cost cap (`Budget` row). The gateway meters LLM
//! spend against it by parsing the provider `usage` object out of the response
//! (see `gateway/hooks.rs`), pricing it against the static [`price`] table, and
//! recording it (see `telemetry.rs`). Enforcement is a PRE-request gate in
//! `hooks::pre_forward`: once a prior request pushes the running total to/over
//! the limit, the NEXT request is denied `402`. The in-flight request that
//! crosses the line completes (cost is only known at stream end), so one
//! request may overshoot — the cap blocks new requests once exceeded.
//!
//! Fail direction: the budget gate fails OPEN. A budget is a cost control, not
//! a security control — a metering/read glitch lets the request through rather
//! than causing a self-inflicted outage. Only the normal over-limit path bites.
//!
//! ⚠ KEEP THE SHARED TYPES (`BudgetBinding`, `BudgetPeriod`) IDENTICAL to
//! `ee/budget.rs`. Only one of the two modules compiles per build (feature
//! swap), so the shared threading in `connect.rs`/`gateway/mitm.rs` uses
//! whichever copy is active. Treat the types as one.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use tracing::warn;

/// One cent = 1e7 nano-dollars (1e-9 USD).
pub(crate) const CENT_TO_NANOS: i64 = 10_000_000;

/// TTL for the hot spend counter. A monthly period rolls to a new counter key
/// on the 1st (so a new month resets regardless of TTL); this bound just forces
/// a periodic rehydrate from the durable `BudgetSpend` floor for `total` caps.
pub(crate) const PERIOD_TTL: u64 = 60 * 60 * 24 * 40; // 40 days

/// How a budget's spend window resets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BudgetPeriod {
    /// Resets on the 1st of each month (UTC).
    Monthly,
    /// Lifetime cap; never resets.
    Total,
}

/// A resolved budget that governs the effective credential for a request's host.
/// Resolved once at connect time and threaded `ConnectResponse → ResolvedRules`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct BudgetBinding {
    pub secret_id: String,
    pub organization_id: String,
    /// Secret type, selects the metering strategy (e.g. "anthropic").
    pub secret_type: String,
    /// Spend ceiling in nano-dollars (1e-9 USD).
    pub limit_nanos: i64,
    pub period: BudgetPeriod,
}

/// Parsed token usage from a metered LLM response.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Usage {
    pub input: u64,
    pub output: u64,
    /// Anthropic `cache_creation_input_tokens` — cache-WRITE tokens, billed at
    /// 1.25× base input and EXCLUDED from `input`. Always 0 for OpenAI (which
    /// folds cached tokens into `prompt_tokens`).
    pub cache_write: u64,
    /// Anthropic `cache_read_input_tokens` — cache-READ tokens, billed at 0.1×
    /// base input and EXCLUDED from `input`. Always 0 for OpenAI.
    pub cache_read: u64,
    /// Model served (from the response body) — selects the price row.
    pub model: String,
}

/// Whether this secret type has a meter + price table entry, so a budget on it
/// can actually be enforced. Everything else is DESCOPED (see the plan): a
/// budget on an unmeterable secret is rejected at create time by the API.
pub(crate) fn is_metered_type(secret_type: &str) -> bool {
    matches!(secret_type, "anthropic" | "openai")
}

/// Resolve budget bindings for the org/project LLM secrets among a request's
/// host-filtered secrets. Loads `Budget` rows for `(organization_id, secret_id ∈
/// metered host-matched secrets)` and maps each to a [`BudgetBinding`]. Errors ⇒
/// log + return `[]` (fail-open at resolution too — no binding ⇒ no cap).
pub(crate) async fn resolve_bindings(
    pool: &sqlx::PgPool,
    org_id: &str,
    secrets: &[crate::db::SecretRow],
) -> Vec<BudgetBinding> {
    // Only metered LLM types can be priced; others can't carry a spend cap.
    let type_by_id: HashMap<&str, &str> = secrets
        .iter()
        .filter(|s| is_metered_type(&s.type_))
        .map(|s| (s.id.as_str(), s.type_.as_str()))
        .collect();
    if type_by_id.is_empty() {
        return Vec::new();
    }

    let ids: Vec<String> = type_by_id.keys().map(|id| id.to_string()).collect();
    let rows = match crate::db::find_budgets_for_secrets(pool, org_id, &ids).await {
        Ok(rows) => rows,
        Err(e) => {
            warn!(error = %e, "budget: failed to load budgets; enforcing none (fail-open)");
            return Vec::new();
        }
    };

    rows.into_iter()
        .filter_map(|row| {
            let secret_type = type_by_id.get(row.secret_id.as_str())?;
            Some(BudgetBinding {
                secret_id: row.secret_id,
                organization_id: org_id.to_string(),
                secret_type: (*secret_type).to_string(),
                limit_nanos: row.limit_cents as i64 * CENT_TO_NANOS,
                period: period_from_str(&row.period),
            })
        })
        .collect()
}

fn period_from_str(s: &str) -> BudgetPeriod {
    match s {
        "total" => BudgetPeriod::Total,
        _ => BudgetPeriod::Monthly,
    }
}

// ── Period + cache keys ──────────────────────────────────────────────────

/// The spend-window key. Monthly → `m:YYYY-MM` (UTC), so a new month is a new
/// key = automatic reset. Total → `total` (lifetime).
pub(crate) fn period_key(period: BudgetPeriod, now: OffsetDateTime) -> String {
    match period {
        BudgetPeriod::Monthly => {
            format!("m:{:04}-{:02}", now.year(), u8::from(now.month()))
        }
        BudgetPeriod::Total => "total".to_string(),
    }
}

/// The hot-counter cache key holding accumulated nano-dollars for this window.
pub(crate) fn counter_key(secret_id: &str, org_id: &str, period_key: &str) -> String {
    format!("budget:spent:{secret_id}:{org_id}:{period_key}")
}

/// Enforcement predicate: a spend cap denies the NEXT request once the running
/// total meets or exceeds the limit. `>=` — at exactly the limit, deny.
pub(crate) fn is_over(spent: i64, limit: i64) -> bool {
    spent >= limit
}

// ── Metering: parse + price ──────────────────────────────────────────────

/// Bounded head/tail budget for the metering copy (per direction), enough for a
/// non-stream JSON `usage` (trailing) or an SSE `message_start` (leading).
pub(crate) const META_CAP: usize = 16 * 1024;

/// Parse the provider `usage` from a bounded response sample. `head` is the
/// first bytes (SSE `message_start` with input tokens + model), `tail` the last
/// bytes (non-stream trailing `usage`, or the SSE final `message_delta` output).
/// Best-effort substring scan — tolerant of truncation; when no usage is present
/// (e.g. OpenAI SSE without `include_usage`) returns `None` ⇒ the caller charges
/// 0 (fail-open). Never fabricates.
pub(crate) fn parse_usage(secret_type: &str, head: &[u8], tail: &[u8]) -> Option<Usage> {
    let (in_key, out_key) = match secret_type {
        "anthropic" => ("input_tokens", "output_tokens"),
        "openai" => ("prompt_tokens", "completion_tokens"),
        _ => return None,
    };
    let h = String::from_utf8_lossy(head);
    let t = String::from_utf8_lossy(tail);

    // Input tokens live in the leading usage (SSE message_start) or the trailing
    // usage (non-stream) — first occurrence in either.
    let input = find_uint(&h, in_key, false).or_else(|| find_uint(&t, in_key, false));
    // Output tokens live in the trailing usage / final message_delta — last
    // occurrence in the tail, then the head as a degraded fallback.
    let output = find_uint(&t, out_key, true).or_else(|| find_uint(&h, out_key, true));
    let model = find_str(&h, "model").or_else(|| find_str(&t, "model"))?;

    // Anthropic reports prompt-cache tokens in fields EXCLUDED from `input_tokens`
    // (`cache_creation_input_tokens`, `cache_read_input_tokens`). Agent workloads
    // lean heavily on caching, so omitting these systematically under-meters
    // input cost. They live in the leading `message_start` usage (SSE) or the
    // trailing usage (non-stream) — first occurrence in either. OpenAI folds its
    // cached tokens into `prompt_tokens`, so they stay 0 there.
    let (cache_write, cache_read) = if secret_type == "anthropic" {
        (
            find_uint(&h, "cache_creation_input_tokens", false)
                .or_else(|| find_uint(&t, "cache_creation_input_tokens", false))
                .unwrap_or(0),
            find_uint(&h, "cache_read_input_tokens", false)
                .or_else(|| find_uint(&t, "cache_read_input_tokens", false))
                .unwrap_or(0),
        )
    } else {
        (0, 0)
    };

    match (input, output, cache_write, cache_read) {
        (None, None, 0, 0) => None,
        (i, o, _, _) => Some(Usage {
            input: i.unwrap_or(0),
            output: o.unwrap_or(0),
            cache_write,
            cache_read,
            model,
        }),
    }
}

/// Price a usage into nano-dollars: `input × input_price + output × output_price`.
/// Unknown model → 0 + `warn!` once (a fabricated price on a blocking control is
/// worse than a documented under-meter).
pub(crate) fn price(secret_type: &str, usage: &Usage) -> i64 {
    match price_per_token(secret_type, &usage.model) {
        // Cache-write is 1.25× (×5/4) and cache-read 0.1× (÷10) of base input;
        // multiply before dividing to keep the integer rounding error sub-token.
        Some((per_in, per_out)) => {
            usage.input as i64 * per_in
                + usage.output as i64 * per_out
                + (usage.cache_write as i64 * per_in * 5) / 4
                + (usage.cache_read as i64 * per_in) / 10
        }
        None => {
            warn!(secret_type, model = %usage.model, "budget: no price for model; metering as 0");
            0
        }
    }
}

/// `(input_nanos_per_token, output_nanos_per_token)` for the given provider +
/// model, by longest-prefix match. Prices are nano-dollars/token = USD-per-M ×
/// 1000. Static curated table; new/unknown models meter as 0 until updated.
fn price_per_token(secret_type: &str, model: &str) -> Option<(i64, i64)> {
    // Ordered arbitrarily; longest matching prefix wins so specific rows
    // (e.g. gpt-4o-mini) beat general ones (gpt-4o, gpt-4).
    const ANTHROPIC: &[(&str, i64, i64)] = &[
        ("claude-opus-5", 5_000, 25_000),
        ("claude-opus-4", 5_000, 25_000),
        ("claude-opus-3", 15_000, 75_000),
        ("claude-3-opus", 15_000, 75_000),
        ("claude-opus", 5_000, 25_000),
        ("claude-fable-5", 10_000, 50_000),
        ("claude-sonnet", 3_000, 15_000),
        ("claude-3-5-sonnet", 3_000, 15_000),
        ("claude-3-7-sonnet", 3_000, 15_000),
        ("claude-3-sonnet", 3_000, 15_000),
        ("claude-haiku-4", 1_000, 5_000),
        ("claude-3-5-haiku", 800, 4_000),
        ("claude-3-haiku", 250, 1_250),
        ("claude-haiku", 1_000, 5_000),
    ];
    const OPENAI: &[(&str, i64, i64)] = &[
        ("gpt-4o-mini", 150, 600),
        ("gpt-4o", 2_500, 10_000),
        ("gpt-4.1-mini", 400, 1_600),
        ("gpt-4.1-nano", 100, 400),
        ("gpt-4.1", 2_000, 8_000),
        ("gpt-4-turbo", 10_000, 30_000),
        ("gpt-4", 30_000, 60_000),
        ("gpt-3.5-turbo", 500, 1_500),
        ("o1-mini", 1_100, 4_400),
        ("o3-mini", 1_100, 4_400),
        ("o1", 15_000, 60_000),
    ];

    let table = match secret_type {
        "anthropic" => ANTHROPIC,
        "openai" => OPENAI,
        _ => return None,
    };
    table
        .iter()
        .filter(|(prefix, _, _)| model.starts_with(prefix))
        .max_by_key(|(prefix, _, _)| prefix.len())
        .map(|(_, per_in, per_out)| (*per_in, *per_out))
}

/// Find the integer following `"key":` in `hay`. `last` picks the final match
/// (streamed final `message_delta`), otherwise the first (leading usage).
fn find_uint(hay: &str, key: &str, last: bool) -> Option<u64> {
    let needle = format!("\"{key}\"");
    let mut found = None;
    let mut idx = 0;
    while let Some(rel) = hay[idx..].find(&needle) {
        let after = idx + rel + needle.len();
        if let Some(n) = uint_after_colon(&hay[after..]) {
            found = Some(n);
            if !last {
                return found;
            }
        }
        idx = after;
    }
    found
}

fn uint_after_colon(s: &str) -> Option<u64> {
    let s = s.trim_start().strip_prefix(':')?.trim_start();
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// Find the string value following the first `"key":` in `hay`.
fn find_str(hay: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let rel = hay.find(&needle)?;
    let rest = hay[rel + needle.len()..]
        .trim_start()
        .strip_prefix(':')?
        .trim_start()
        .strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

// ── Tests (pure unit — no DB/network) ────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use time::{Date, Month};

    /// Build a UTC `OffsetDateTime` without needing the `time` `macros` feature.
    fn utc(year: i32, month: Month, day: u8) -> OffsetDateTime {
        Date::from_calendar_date(year, month, day)
            .unwrap()
            .midnight()
            .assume_utc()
    }

    #[test]
    fn is_metered_type_covers_anthropic_openai_only() {
        assert!(is_metered_type("anthropic"));
        assert!(is_metered_type("openai"));
        assert!(!is_metered_type("generic"));
        assert!(!is_metered_type("github-app"));
    }

    #[test]
    fn parse_anthropic_non_stream() {
        let body = br#"{"id":"msg_1","model":"claude-sonnet-4-5-20250929","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":100,"output_tokens":50}}"#;
        let u = parse_usage("anthropic", body, body).unwrap();
        assert_eq!(u.input, 100);
        assert_eq!(u.output, 50);
        assert_eq!(u.model, "claude-sonnet-4-5-20250929");
    }

    #[test]
    fn parse_openai_non_stream() {
        let body = br#"{"id":"cmpl","model":"gpt-4o-mini","choices":[],"usage":{"prompt_tokens":200,"completion_tokens":80,"total_tokens":280}}"#;
        let u = parse_usage("openai", body, body).unwrap();
        assert_eq!(u.input, 200);
        assert_eq!(u.output, 80);
        assert_eq!(u.model, "gpt-4o-mini");
    }

    #[test]
    fn parse_anthropic_sse_head_and_tail() {
        // input + model in message_start (head); final output in message_delta (tail).
        let head = br#"event: message_start
data: {"type":"message_start","message":{"model":"claude-opus-4-1-20250805","usage":{"input_tokens":1200,"output_tokens":1}}}
"#;
        let tail = br#"event: message_delta
data: {"type":"message_delta","delta":{},"usage":{"output_tokens":640}}
"#;
        let u = parse_usage("anthropic", head, tail).unwrap();
        assert_eq!(u.input, 1200);
        assert_eq!(u.output, 640);
        assert_eq!(u.model, "claude-opus-4-1-20250805");
    }

    #[test]
    fn parse_anthropic_cache_tokens() {
        // A cache-write turn: small non-cached input_tokens plus the more
        // expensive cache_creation, and a cache_read on top — all excluded from
        // input_tokens and each parsed into its own field.
        let body = br#"{"id":"msg_1","model":"claude-sonnet-4-5","usage":{"input_tokens":10,"cache_creation_input_tokens":2000,"cache_read_input_tokens":500,"output_tokens":40}}"#;
        let u = parse_usage("anthropic", body, body).unwrap();
        assert_eq!(u.input, 10);
        assert_eq!(u.output, 40);
        assert_eq!(u.cache_write, 2000);
        assert_eq!(u.cache_read, 500);
    }

    #[test]
    fn parse_openai_ignores_cache_fields() {
        // OpenAI folds cached tokens into prompt_tokens; the anthropic-only cache
        // fields must never be read for openai even if present in the body.
        let body = br#"{"model":"gpt-4o","usage":{"prompt_tokens":100,"completion_tokens":20,"cache_creation_input_tokens":999}}"#;
        let u = parse_usage("openai", body, body).unwrap();
        assert_eq!(u.cache_write, 0);
        assert_eq!(u.cache_read, 0);
    }

    #[test]
    fn price_anthropic_cache_tokens_exact_math() {
        // sonnet base input = 3000 nanos/token. cache_write bills 1.25× (3750),
        // cache_read 0.1× (300).
        let u = Usage {
            input: 100,
            output: 50,
            cache_write: 1_000,
            cache_read: 2_000,
            model: "claude-sonnet-4-5".to_string(),
        };
        // 100*3000 + 50*15000 + 1000*3750 + 2000*300
        // = 300_000 + 750_000 + 3_750_000 + 600_000
        assert_eq!(price("anthropic", &u), 5_400_000);
    }

    #[test]
    fn parse_openai_sse_without_usage_is_none() {
        let body = br#"data: {"choices":[{"delta":{"content":"hi"}}],"model":"gpt-4o"}

data: [DONE]
"#;
        assert!(parse_usage("openai", body, body).is_none());
    }

    #[test]
    fn parse_missing_usage_but_model_is_none() {
        let body = br#"{"model":"claude-sonnet-4-5","content":[]}"#;
        assert!(parse_usage("anthropic", body, body).is_none());
    }

    #[test]
    fn parse_truncated_garbage_is_none() {
        assert!(parse_usage("anthropic", b"{not json at al", b"l").is_none());
    }

    #[test]
    fn parse_wrong_provider_is_none() {
        let body = br#"{"model":"x","usage":{"input_tokens":5,"output_tokens":5}}"#;
        assert!(parse_usage("generic", body, body).is_none());
    }

    #[test]
    fn price_known_model_exact_math() {
        let u = Usage {
            input: 1_000,
            output: 2_000,
            cache_write: 0,
            cache_read: 0,
            model: "claude-sonnet-4-5".to_string(),
        };
        // 1000*3000 + 2000*15000 = 3_000_000 + 30_000_000
        assert_eq!(price("anthropic", &u), 33_000_000);
    }

    #[test]
    fn price_longest_prefix_wins() {
        let mini = Usage {
            input: 1_000_000,
            output: 0,
            cache_write: 0,
            cache_read: 0,
            model: "gpt-4o-mini-2024".to_string(),
        };
        assert_eq!(price("openai", &mini), 150_000_000); // 1e6 * 150
        let full = Usage {
            input: 1_000_000,
            output: 0,
            cache_write: 0,
            cache_read: 0,
            model: "gpt-4o-2024".to_string(),
        };
        assert_eq!(price("openai", &full), 2_500_000_000); // 1e6 * 2500
    }

    #[test]
    fn price_zero_tokens_is_zero() {
        let u = Usage {
            input: 0,
            output: 0,
            cache_write: 0,
            cache_read: 0,
            model: "claude-opus-4-1".to_string(),
        };
        assert_eq!(price("anthropic", &u), 0);
    }

    #[test]
    fn price_unknown_model_is_zero_no_panic() {
        let u = Usage {
            input: 1_000,
            output: 1_000,
            cache_write: 0,
            cache_read: 0,
            model: "some-unlisted-model".to_string(),
        };
        assert_eq!(price("anthropic", &u), 0);
    }

    #[test]
    fn period_key_monthly_zero_pads() {
        let key = period_key(BudgetPeriod::Monthly, utc(2026, Month::July, 29));
        assert_eq!(key, "m:2026-07");
        let jan = period_key(BudgetPeriod::Monthly, utc(2027, Month::January, 1));
        assert_eq!(jan, "m:2027-01");
    }

    #[test]
    fn period_key_dec_jan_rollover_distinct() {
        let dec = period_key(BudgetPeriod::Monthly, utc(2026, Month::December, 31));
        let jan = period_key(BudgetPeriod::Monthly, utc(2027, Month::January, 1));
        assert_eq!(dec, "m:2026-12");
        assert_eq!(jan, "m:2027-01");
        assert_ne!(dec, jan);
    }

    #[test]
    fn period_key_total_is_constant() {
        assert_eq!(
            period_key(BudgetPeriod::Total, utc(2026, Month::July, 29)),
            "total"
        );
    }

    #[test]
    fn counter_key_stable_and_collision_free() {
        let a = counter_key("sec1", "org1", "m:2026-07");
        assert_eq!(a, "budget:spent:sec1:org1:m:2026-07");
        assert_ne!(a, counter_key("sec2", "org1", "m:2026-07"));
        assert_ne!(a, counter_key("sec1", "org2", "m:2026-07"));
        assert_ne!(a, counter_key("sec1", "org1", "m:2026-08"));
    }

    #[test]
    fn is_over_boundary() {
        assert!(!is_over(99, 100)); // under
        assert!(is_over(100, 100)); // exactly at → deny
        assert!(is_over(101, 100)); // over
        assert!(!is_over(0, 100));
    }

    #[test]
    fn cent_to_nanos_conversion() {
        // 500 cents ($5.00) → 5e9 nano-dollars
        assert_eq!(500 * CENT_TO_NANOS, 5_000_000_000);
    }
}
