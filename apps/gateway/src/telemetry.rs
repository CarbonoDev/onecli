//! Request telemetry: Postgres request logging.
//!
//! Logs every credential-injected request to the `request_logs` table via a
//! background batch INSERT. Zero latency impact on the request path.
//!
//! OSS: Postgres only. Cloud swaps this module via `#[cfg(edition_cloud)]`
//! to add PostHog analytics + Redis credit counters.

use std::sync::Arc;

use serde_json::json;
use sqlx::PgPool;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::cache::CacheStore;
use crate::telemetry_core::{
    collect_batch, extract_columns, RequestDecision, CHANNEL_CAPACITY, FLUSH_BATCH_SIZE, SENDER,
};

// Re-export shared types for consumer code
pub(crate) use crate::telemetry_core::{on_request, RequestEvent};

/// Initialize the telemetry background flush task.
/// Must be called once at startup from `main()`.
pub(crate) fn init(pool: PgPool, cache: Arc<dyn CacheStore>) {
    let (tx, rx) = mpsc::channel::<RequestEvent>(CHANNEL_CAPACITY);
    SENDER.set(tx).ok();
    crate::telemetry_core::spawn_flush_loop(flush_loop(rx, pool, cache));
    info!("telemetry initialized (postgres)");
}

/// The identity of a spend counter: `(secret_id, organization_id, period_key)`.
type SpendKey = (String, String, String);

/// Record a metered spend delta for one counter: accumulate the durable
/// `BudgetSpend` floor and seed the hot counter to the new coherent total. Runs
/// off the request path (in the flush loop), so no request-path latency. Failures
/// are logged, never fatal (fail-open on spend).
async fn record_spend(pool: &PgPool, cache: &dyn CacheStore, key: &SpendKey, delta: i64) {
    let (secret_id, organization_id, period_key) = key;
    match crate::db::upsert_budget_spend(pool, secret_id, organization_id, period_key, delta).await
    {
        Ok(total) => {
            // RECONCILE, don't overwrite. The cache was already incremented for
            // this charge (`charge_cache` below), and may have been incremented
            // again for a charge that lands in the NEXT batch. A blind
            // `set_raw(total)` would roll those newer charges back and let spend
            // through twice.
            //
            // The durable row is a FLOOR: raise the counter to it when the cache
            // is behind (cold start, eviction, a lost increment), never lower it.
            let counter = crate::budget::counter_key(secret_id, organization_id, period_key);
            let cached = cache
                .get_raw(&counter)
                .await
                .and_then(|raw| raw.parse::<i64>().ok());
            if cached.is_none_or(|c| c < total) {
                cache
                    .set_raw(&counter, &total.to_string(), crate::budget::PERIOD_TTL)
                    .await;
            }
        }
        Err(e) => {
            warn!(error = %e, secret_id = %secret_id, "budget: failed to record spend");
        }
    }
}

/// Apply a charge to the hot counter the moment it is drained from the channel,
/// rather than waiting for the batch to reach PostgreSQL.
///
/// `pre_forward` reads this counter to decide whether to deny with 402. Before
/// this, the counter only moved when the flush loop completed its upsert, so
/// requests arriving between a charge and its flush all read the same stale
/// total and were all admitted. The window was small — `collect_batch` returns
/// as soon as one event arrives, so the 5s interval only applies when idle —
/// but it was wide enough for concurrent requests against one budget.
///
/// Fail-open, like every other budget read: a cache miss returns None and the
/// request proceeds. The durable floor in `record_spend` repairs the counter.
async fn charge_cache(cache: &dyn CacheStore, key: &SpendKey, delta: i64) {
    let (secret_id, organization_id, period_key) = key;
    let counter = crate::budget::counter_key(secret_id, organization_id, period_key);
    cache
        .incr_by(&counter, delta, crate::budget::PERIOD_TTL)
        .await;
}

async fn insert_batch(pool: &PgPool, events: &[RequestEvent]) -> Result<(), sqlx::Error> {
    let filtered: Vec<&RequestEvent> = events
        .iter()
        .filter(|e| e.injected || !matches!(e.decision, RequestDecision::Allowed))
        .collect();
    if filtered.is_empty() {
        return Ok(());
    }
    let c = extract_columns(&filtered);

    sqlx::query(
        "INSERT INTO request_logs (id, project_id, agent_id, method, host, path, provider, status, latency_ms, injection_count)
         SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::int4[], $9::int4[], $10::int4[])",
    )
    .bind(&c.ids)
    .bind(&c.project_ids)
    .bind(&c.agent_ids)
    .bind(&c.methods)
    .bind(&c.hosts)
    .bind(&c.paths)
    .bind(&c.providers)
    .bind(&c.statuses)
    .bind(&c.latencies)
    .bind(&c.injections)
    .execute(pool)
    .await?;

    Ok(())
}

async fn update_batch(pool: &PgPool, events: &[RequestEvent]) {
    for event in events {
        let Some(log_id) = event.existing_log_id.as_ref() else {
            continue;
        };
        let extra = match &event.decision {
            RequestDecision::ApprovalApproved {
                approval_id,
                triggered_at,
                resolved_at,
                approved_by,
            } => json!({
                "decision": "approval_approved",
                "approval_id": approval_id,
                "triggered_at": triggered_at,
                "resolved_at": resolved_at,
                "approved_by": approved_by,
            })
            .to_string(),
            RequestDecision::ApprovalDenied {
                approval_id,
                reason,
                triggered_at,
                resolved_at,
                approved_by,
            } => json!({
                "decision": "approval_denied",
                "approval_id": approval_id,
                "approval_reason": reason,
                "triggered_at": triggered_at,
                "resolved_at": resolved_at,
                "approved_by": approved_by,
            })
            .to_string(),
            _ => "{}".to_string(),
        };
        if let Err(e) = sqlx::query(
            "UPDATE request_logs \
             SET status = $1, latency_ms = $2, \
                 extra_data = COALESCE(extra_data, '{}'::jsonb) || $3::jsonb \
             WHERE id = $4",
        )
        .bind(event.status as i32)
        .bind(event.latency_ms as i32)
        .bind(&extra)
        .bind(log_id)
        .execute(pool)
        .await
        {
            warn!(log_id = %log_id, error = %e, "telemetry approval update failed");
        }
    }
}

async fn flush_loop(
    mut rx: mpsc::Receiver<RequestEvent>,
    pool: PgPool,
    cache: Arc<dyn CacheStore>,
) {
    let mut buffer: Vec<RequestEvent> = Vec::with_capacity(FLUSH_BATCH_SIZE);

    loop {
        if !collect_batch(&mut rx, &mut buffer).await {
            break;
        }

        if buffer.is_empty() {
            continue;
        }

        // Sum metered spend per counter across the whole drained batch, so a
        // busy flush does one upsert per distinct (secret, org, period) rather
        // than one per request event. Durability boundary: a charge is volatile
        // in the in-memory channel until this runs — a crash before the upsert
        // loses at most the unflushed tail (≤FLUSH_INTERVAL_SECS), a fail-open
        // under-count consistent with the async-telemetry design; flushed spend
        // survives restart (rehydrated from the durable `BudgetSpend` floor).
        let mut charges: std::collections::HashMap<SpendKey, i64> =
            std::collections::HashMap::new();
        let mut updates = Vec::new();
        let mut regular = Vec::new();
        for event in buffer.drain(..) {
            if let Some(charge) = event.budget_charge.as_ref() {
                *charges
                    .entry((
                        charge.secret_id.clone(),
                        charge.organization_id.clone(),
                        charge.period_key.clone(),
                    ))
                    .or_default() += charge.cost_nanos;
            }
            if event.existing_log_id.is_some() {
                updates.push(event);
            } else {
                regular.push(event);
            }
        }

        // Move the hot counter FIRST, before the (slower) database round-trip:
        // this is what `pre_forward` reads, so every microsecond it lags is a
        // window in which a concurrent request sees a stale total.
        for (key, delta) in &charges {
            charge_cache(cache.as_ref(), key, *delta).await;
        }

        // Then persist, and reconcile the counter against the durable floor.
        for (key, delta) in &charges {
            record_spend(&pool, cache.as_ref(), key, *delta).await;
        }

        if let Err(e) = insert_batch(&pool, &regular).await {
            warn!(count = regular.len(), error = %e, "telemetry batch insert failed");
        }

        if !updates.is_empty() {
            update_batch(&pool, &updates).await;
        }

        buffer.clear();
    }
}
