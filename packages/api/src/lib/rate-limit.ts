/**
 * A small in-process token bucket.
 *
 * Scope note, stated plainly: this is per-process. With N replicas the
 * effective ceiling is N × the configured rate. That is acceptable for what it
 * defends — it damps a misconfigured sender and blunts scanning, it is not the
 * security boundary. The real backstops on the ingest path are the body cap,
 * the 128-bit unguessable endpoint id, and database-level dedup. A Redis-backed
 * limiter (ioredis is already a dependency) is the upgrade if a true global
 * ceiling is ever needed.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until at least one token is available; 0 when allowed. */
  retryAfterSec: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * Bounded: keys come from request paths, so an unbounded map would be a memory
 * leak an unauthenticated caller controls.
 */
const MAX_KEYS = 10_000;
const PRUNE_FRACTION = 0.2;

const buckets = new Map<string, Bucket>();

const prune = () => {
  const victims = [...buckets.entries()]
    .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    .slice(0, Math.ceil(MAX_KEYS * PRUNE_FRACTION));
  for (const [key] of victims) buckets.delete(key);
};

export const consumeRateLimit = (
  key: string,
  perMinute: number,
  now = Date.now(),
): RateLimitDecision => {
  const refillPerMs = perMinute / 60_000;
  const bucket = buckets.get(key);

  if (!bucket) {
    if (buckets.size >= MAX_KEYS) prune();
    buckets.set(key, { tokens: perMinute - 1, updatedAt: now });
    return { allowed: true, retryAfterSec: 0 };
  }

  const refilled = Math.min(
    perMinute,
    bucket.tokens + (now - bucket.updatedAt) * refillPerMs,
  );
  bucket.updatedAt = now;

  if (refilled < 1) {
    bucket.tokens = refilled;
    return {
      allowed: false,
      retryAfterSec: Math.max(
        1,
        Math.ceil((1 - refilled) / refillPerMs / 1000),
      ),
    };
  }

  bucket.tokens = refilled - 1;
  return { allowed: true, retryAfterSec: 0 };
};

/** Test seam. */
export const resetRateLimits = () => buckets.clear();
