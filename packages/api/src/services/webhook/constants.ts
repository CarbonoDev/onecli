/**
 * Tuning constants for the webhook receiver and its delivery pull queue.
 *
 * Collected in one file because several of them are load-bearing against
 * things outside this codebase (a provider's ack budget, a load balancer's
 * idle timeout) and are much easier to review together than scattered across
 * the services that consume them.
 */

export const WEBHOOK_PUBLIC_ID_PREFIX = "whe_";
export const WEBHOOK_PUBLIC_ID_RE = /^whe_[0-9a-f]{32}$/;
export const WEBHOOK_SECRET_PREFIX = "whsec_";

/**
 * Ingest body cap. GitHub's own limit is 25 MB; nothing we render needs that,
 * and every byte here is buffered in memory before verification.
 */
export const WEBHOOK_MAX_BODY_BYTES = 1_048_576; // 1 MiB

/** Rendered text caps, in characters. */
export const RENDER_MAX_OUTPUT = 16_000;
/** A single `{{path}}` substitution that resolves to an object or a long string. */
export const RENDER_MAX_VALUE = 2_000;
/** The `{{$raw}}` special. */
export const RENDER_MAX_RAW = 8_000;

/** Queue tuning. */
export const QUEUE_MAX_ATTEMPTS = 5;
export const QUEUE_DEFAULT_BATCH = 10;
export const QUEUE_MAX_BATCH = 25;
export const QUEUE_DEFAULT_LEASE_SEC = 120;
export const QUEUE_MIN_LEASE_SEC = 10;
export const QUEUE_MAX_LEASE_SEC = 300;
/** Retryable-nack backoff: 30s, 1m, 2m, 4m, … capped at 15m, ±20% jitter. */
export const QUEUE_BACKOFF_BASE_MS = 30_000;
export const QUEUE_BACKOFF_MAX_MS = 900_000;

/**
 * Long-poll bounds. `POLL_MAX_WAIT_SEC` MUST stay under the smallest idle
 * timeout in front of Next — an AWS ALB defaults to 60s, Cloudflare to 100s.
 * Nothing flows on the wire during a wait, so an over-long park is torn down
 * as idle and the poller sees a 504 instead of an empty batch.
 */
export const POLL_DEFAULT_WAIT_SEC = 25;
export const POLL_MAX_WAIT_SEC = 50;
/**
 * How often a parked poller re-checks the queue. This loop — not the
 * in-process notifier — is the correctness floor: a delivery ingested on one
 * replica must still reach a poller parked on another.
 */
export const POLL_INTERVAL_MS = 750;
export const POLL_JITTER_MS = 250;

/** Envelope: omit the raw payload above this many serialized bytes. */
export const ENVELOPE_PAYLOAD_MAX_BYTES = 65_536;

/** Persisted `lastError` cap. */
export const ACK_ERROR_MAX_CHARS = 2_000;

/**
 * Headers persisted on a delivery. Everything else is dropped — in particular
 * `authorization`, `cookie`, and the signature header itself, none of which
 * should be readable from the delivery log.
 */
export const HEADER_ALLOWLIST: readonly string[] = [
  "content-type",
  "user-agent",
  "x-github-event",
  "x-github-delivery",
  "x-github-hook-id",
  "x-github-hook-installation-target-type",
  "x-event-type",
  "x-delivery-id",
  "idempotency-key",
];

/** Retention windows, in days. */
export const RETAIN_DELIVERED_DAYS = 7;
export const RETAIN_DISCARDED_DAYS = 7;
/** Rejected rows are unauthenticated writes — keep them only long enough to debug. */
export const RETAIN_REJECTED_DAYS = 1;
export const RETAIN_FAILED_DAYS = 30;
export const RETAIN_PENDING_DAYS = 30;
export const SWEEP_BATCH = 5_000;
export const SWEEP_MAX_PASSES = 5;
export const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/** Delivery status values. In-flight is derived, not stored — see the schema. */
export const DELIVERY_STATUS = {
  PENDING: "pending",
  DELIVERED: "delivered",
  FAILED: "failed",
  DISCARDED: "discarded",
} as const;

export type DeliveryStatus =
  (typeof DELIVERY_STATUS)[keyof typeof DELIVERY_STATUS];

/** Why a discarded row was never queued. */
export const DISCARD_REASON = {
  HANDSHAKE: "handshake",
  REJECTED: "rejected",
  DISABLED: "disabled",
} as const;

export type DiscardReason =
  (typeof DISCARD_REASON)[keyof typeof DISCARD_REASON];
