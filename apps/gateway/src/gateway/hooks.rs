//! Forward hooks — extension points for the request forwarding pipeline.
//!
//! OSS spend budgets live here:
//! - [`pre_forward`] is the PRE-request enforcement gate: read the running spend
//!   total for each metered budget binding and deny `402` if it already meets or
//!   exceeds the cap. Fails OPEN — a read error lets the request through.
//! - [`track_and_wrap`] is the POST-response meter: when a metered budget binding
//!   applies it tees a bounded copy of the response stream, parses the provider
//!   `usage` at stream end, prices it, and attaches a `BudgetCharge` to the
//!   emitted `RequestEvent` (the telemetry flush accumulates it).
//!
//! Not budgets, but the same seam:
//! - [`refuse_empty_scope`] refuses a request whose resource scope allows
//!   nothing, before any credential is materialized. A no-op here: this fork
//!   enforces resource scope at the REQUEST layer in `policy_engine::scope`,
//!   not by minting a narrowed credential, so there is no empty-scope mint to
//!   refuse. See `ee_apps::has_request_guard`.

use std::pin::Pin;
use std::task::{Context, Poll};

use futures_util::{Stream, TryStreamExt};
use http_body_util::{Either, Full, StreamBody};
use hyper::body::{Bytes, Frame};
use hyper::header::CONTENT_TYPE;
use hyper::{Response, StatusCode};

use super::mitm::ResolvedRules;
use super::ProxyContext;
use crate::budget::{self, BudgetBinding};

// ── Shared types ────────────────────────────────────────────────────────

pub(crate) type BodyStream =
    Pin<Box<dyn futures_util::Stream<Item = Result<Frame<Bytes>, reqwest::Error>> + Send>>;

/// Raw upstream body stream (bytes), before framing.
type RawBodyStream =
    Pin<Box<dyn futures_util::Stream<Item = Result<Bytes, reqwest::Error>> + Send>>;

pub(crate) type ForwardResponseBody = Either<Full<Bytes>, StreamBody<BodyStream>>;

/// Common telemetry fields for a proxied request, passed from forward to hooks.
pub(crate) struct RequestMeta {
    pub org_id: String,
    pub project_id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub method: String,
    pub host: String,
    pub path: String,
    pub provider: String,
    pub status: u16,
    pub latency_ms: u32,
    pub injection_count: u16,
    pub timestamp: String,
    pub injected: bool,
    pub connection_label: Option<String>,
    pub existing_log_id: Option<String>,
    pub decision: Option<crate::telemetry_core::RequestDecision>,
    /// The v2 rule that decided this (allowed) request, when the new engine is
    /// authoritative — threaded to telemetry for "decided by rule X".
    pub matched_rule: Option<crate::policy::MatchedRule>,
}

// ── Hooks ───────────────────────────────────────────────────────────────

/// Pre-forward request-header hook. When a metered budget binding applies to this
/// host, force `Accept-Encoding: identity`.
///
/// The meter reads the provider `usage` object out of the response bytes
/// ([`track_and_wrap`]). `reqwest` is built WITHOUT gzip/brotli/deflate, and the
/// client's `accept-encoding` is otherwise forwarded upstream verbatim — so a
/// client default of `gzip` (the httpx/urllib3 SDKs) would make the provider
/// return compressed bytes that [`budget::parse_usage`] cannot scan, silently
/// charging 0 and never firing the cap. Overriding to `identity` keeps the tee'd
/// copy parseable. (Streaming/SSE is served identity-encoded anyway; this closes
/// the non-stream compressed gap.)
pub(crate) fn prepare_request(
    rules: &ResolvedRules,
    _host: &str,
    _path: &str,
    headers: &mut hyper::HeaderMap,
) {
    let has_metered = rules
        .budget_bindings
        .iter()
        .any(|b| budget::is_metered_type(&b.secret_type));
    if has_metered {
        headers.insert(
            hyper::header::ACCEPT_ENCODING,
            hyper::header::HeaderValue::from_static("identity"),
        );
    }
}

/// Whether the request guard needs the buffered request body to make a
/// decision. OSS has no request guard → never buffer.
pub(crate) fn needs_request_body(
    _rules: &ResolvedRules,
    _host: &str,
    _method: &str,
    _path: &str,
) -> bool {
    false
}

/// Refuse a request whose resource scope allows nothing, before any credential
/// is materialized or served. OSS stores no resource scopes → always allowed.
pub(crate) fn refuse_empty_scope(
    _rules: &ResolvedRules,
    _proxy_ctx: &ProxyContext,
    _host: &str,
    _method: &str,
    _path: &str,
) -> Option<Response<ForwardResponseBody>> {
    None
}

/// PRE-request budget gate. For each metered budget binding, read the running
/// spend total and deny `402 Payment Required` if it already meets/exceeds the
/// cap (stricter-verdict: any binding over ⇒ deny). Runs after the security
/// gates, so a policy-denied request is never budget-checked. Fails OPEN — if a
/// total can't be read, the request proceeds.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn pre_forward(
    rules: &ResolvedRules,
    _proxy_ctx: &ProxyContext,
    _host: &str,
    cache: &dyn crate::cache::CacheStore,
    pool: &sqlx::PgPool,
    _injection_count: usize,
    _method: &str,
    _path: &str,
    _headers: &hyper::HeaderMap,
    _body: Option<&[u8]>,
) -> Option<Response<ForwardResponseBody>> {
    for binding in &rules.budget_bindings {
        if !budget::is_metered_type(&binding.secret_type) {
            continue;
        }
        let period_key = budget::period_key(binding.period, time::OffsetDateTime::now_utc());
        // Fail-open: only a readable total that is over the cap denies.
        if let Some(spent) = read_running_total(cache, pool, binding, &period_key).await {
            if budget::is_over(spent, binding.limit_nanos) {
                tracing::warn!(
                    secret_id = %binding.secret_id,
                    spent,
                    limit = binding.limit_nanos,
                    "BUDGET exceeded — denying request (402)"
                );
                return Some(budget_denied_response(binding, spent));
            }
        }
    }
    None
}

/// Read the hot spend counter (nano-dollars). On cache miss, rehydrate once from
/// the durable `BudgetSpend` floor and seed the counter. Returns `None` only on
/// an unreadable state (fail-open at the call site).
async fn read_running_total(
    cache: &dyn crate::cache::CacheStore,
    pool: &sqlx::PgPool,
    binding: &BudgetBinding,
    period_key: &str,
) -> Option<i64> {
    let key = budget::counter_key(&binding.secret_id, &binding.organization_id, period_key);
    if let Some(raw) = cache.get_raw(&key).await {
        return raw.parse::<i64>().ok();
    }
    match crate::db::read_budget_spend(
        pool,
        &binding.secret_id,
        &binding.organization_id,
        period_key,
    )
    .await
    {
        Ok(spent) => {
            let value = spent.unwrap_or(0);
            cache
                .set_raw(&key, &value.to_string(), budget::PERIOD_TTL)
                .await;
            Some(value)
        }
        Err(e) => {
            tracing::warn!(error = %e, "budget: spend read failed; allowing request (fail-open)");
            None
        }
    }
}

/// Build the structured `402` deny body so the SDK can render "spend cap reached"
/// distinctly from a `429` rate-limit.
fn budget_denied_response(binding: &BudgetBinding, spent: i64) -> Response<ForwardResponseBody> {
    let period = match binding.period {
        budget::BudgetPeriod::Monthly => "monthly",
        budget::BudgetPeriod::Total => "total",
    };
    let body = serde_json::json!({
        "error": "budget_exceeded",
        "secretId": binding.secret_id,
        "period": period,
        "limitCents": binding.limit_nanos / budget::CENT_TO_NANOS,
        "spentCents": spent / budget::CENT_TO_NANOS,
    });
    let bytes = serde_json::to_vec(&body).unwrap_or_default();
    let mut resp = Response::new(Either::Left(Full::new(Bytes::from(bytes))));
    *resp.status_mut() = StatusCode::PAYMENT_REQUIRED;
    resp.headers_mut().insert(
        CONTENT_TYPE,
        hyper::header::HeaderValue::from_static("application/json"),
    );
    resp
}

/// Request-body transform hook. OSS: passthrough. The cloud build injects a
/// claim note into LLM requests for unclaimed (partner-created) orgs.
pub(crate) async fn prepare_request_body(
    _rules: &ResolvedRules,
    _host: &str,
    body: reqwest::Body,
) -> reqwest::Body {
    body
}

/// POST-response telemetry + optional spend metering. When a metered budget
/// binding applies, the response stream is teed (bounded copy) so the emitted
/// `RequestEvent` carries a priced `BudgetCharge`; otherwise telemetry emits
/// immediately and the stream passes through unchanged.
pub(crate) fn track_and_wrap(
    meta: RequestMeta,
    rules: &ResolvedRules,
    _resp_headers: &hyper::HeaderMap,
    stream: impl futures_util::Stream<Item = Result<Bytes, reqwest::Error>> + Send + 'static,
) -> BodyStream {
    let event = build_event(meta);

    // 0/1 metered binding per host in practice; take the first that can be priced.
    let metered = rules
        .budget_bindings
        .iter()
        .find(|b| budget::is_metered_type(&b.secret_type))
        .cloned();

    match metered {
        Some(binding) => Box::pin(MeteredStream::new(Box::pin(stream), event, binding)),
        None => {
            crate::telemetry::on_request(event);
            Box::pin(stream.map_ok(Frame::data))
        }
    }
}

fn build_event(meta: RequestMeta) -> crate::telemetry::RequestEvent {
    crate::telemetry::RequestEvent {
        org_id: meta.org_id,
        project_id: meta.project_id,
        agent_id: meta.agent_id,
        agent_name: meta.agent_name,
        method: meta.method,
        host: meta.host,
        path: meta.path,
        provider: meta.provider,
        status: meta.status,
        latency_ms: meta.latency_ms,
        injection_count: meta.injection_count,
        timestamp: meta.timestamp,
        injected: meta.injected,
        decision: meta
            .decision
            .unwrap_or(crate::telemetry_core::RequestDecision::Allowed),
        connection_label: meta.connection_label,
        existing_log_id: meta.existing_log_id,
        log_id: None,
        budget_charge: None,
        matched_rule: meta.matched_rule,
    }
}

// ── Metered response stream ──────────────────────────────────────────────

/// Wraps the upstream body: forwards every frame unchanged while appending a
/// bounded head (leading bytes — SSE `message_start`) and rolling tail (trailing
/// bytes — non-stream `usage` / SSE final `message_delta`) copy. At stream end
/// it parses + prices the usage and emits the `RequestEvent` with the charge. If
/// the stream is dropped before completion, the base event (no charge) is still
/// emitted — fail-open on the charge, no lost request log.
struct MeteredStream {
    inner: RawBodyStream,
    head: Vec<u8>,
    tail: Vec<u8>,
    /// Taken exactly once — by `finalize` on clean end, else by `Drop`.
    event: Option<crate::telemetry::RequestEvent>,
    binding: BudgetBinding,
}

impl MeteredStream {
    fn new(
        inner: RawBodyStream,
        event: crate::telemetry::RequestEvent,
        binding: BudgetBinding,
    ) -> Self {
        Self {
            inner,
            head: Vec::new(),
            tail: Vec::new(),
            event: Some(event),
            binding,
        }
    }

    fn absorb(&mut self, bytes: &[u8]) {
        if self.head.len() < budget::META_CAP {
            let take = (budget::META_CAP - self.head.len()).min(bytes.len());
            self.head.extend_from_slice(&bytes[..take]);
        }
        self.tail.extend_from_slice(bytes);
        if self.tail.len() > budget::META_CAP {
            let excess = self.tail.len() - budget::META_CAP;
            self.tail.drain(0..excess);
        }
    }

    /// Compute the charge and emit the event on clean stream end.
    fn finalize(&mut self) {
        let Some(mut event) = self.event.take() else {
            return;
        };
        if let Some(usage) = budget::parse_usage(&self.binding.secret_type, &self.head, &self.tail)
        {
            let cost = budget::price(&self.binding.secret_type, &usage);
            if cost > 0 {
                event.budget_charge = Some(crate::telemetry_core::BudgetCharge {
                    secret_id: self.binding.secret_id.clone(),
                    organization_id: self.binding.organization_id.clone(),
                    period_key: budget::period_key(
                        self.binding.period,
                        time::OffsetDateTime::now_utc(),
                    ),
                    cost_nanos: cost,
                });
            }
        }
        crate::telemetry::on_request(event);
    }
}

impl Stream for MeteredStream {
    type Item = Result<Frame<Bytes>, reqwest::Error>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        match this.inner.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(bytes))) => {
                this.absorb(&bytes);
                Poll::Ready(Some(Ok(Frame::data(bytes))))
            }
            Poll::Ready(Some(Err(e))) => Poll::Ready(Some(Err(e))),
            Poll::Ready(None) => {
                this.finalize();
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for MeteredStream {
    fn drop(&mut self) {
        // Dropped before clean end (client disconnect): emit the base event so
        // the request log is preserved; no charge (fail-open).
        if let Some(event) = self.event.take() {
            crate::telemetry::on_request(event);
        }
    }
}
