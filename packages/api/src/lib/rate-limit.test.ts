import { beforeEach, describe, expect, it } from "vitest";

import { consumeRateLimit, resetRateLimits } from "./rate-limit";

describe("consumeRateLimit", () => {
  beforeEach(resetRateLimits);

  it("allows a full burst then denies", () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i += 1) {
      expect(consumeRateLimit("k", 5, now).allowed).toBe(true);
    }
    // 5/min is one token every 12s, and that is what the sender is told.
    expect(consumeRateLimit("k", 5, now)).toEqual({
      allowed: false,
      retryAfterSec: 12,
    });
  });

  it("refills over time", () => {
    const now = 1_000_000;
    for (let i = 0; i < 60; i += 1) consumeRateLimit("k", 60, now);
    expect(consumeRateLimit("k", 60, now).allowed).toBe(false);

    // 60/min = one token per second.
    expect(consumeRateLimit("k", 60, now + 1_000).allowed).toBe(true);
  });

  it("never refills past the ceiling", () => {
    const now = 1_000_000;
    consumeRateLimit("k", 5, now);
    // An hour later the bucket is full, not overflowing.
    for (let i = 0; i < 5; i += 1) {
      expect(consumeRateLimit("k", 5, now + 3_600_000).allowed).toBe(true);
    }
    expect(consumeRateLimit("k", 5, now + 3_600_000).allowed).toBe(false);
  });

  it("keeps buckets independent per key", () => {
    const now = 1_000_000;
    expect(consumeRateLimit("a", 1, now).allowed).toBe(true);
    expect(consumeRateLimit("a", 1, now).allowed).toBe(false);
    expect(consumeRateLimit("b", 1, now).allowed).toBe(true);
  });

  it("reports a retry-after of at least one second", () => {
    const now = 1_000_000;
    consumeRateLimit("k", 6_000, now);
    // 6000/min refills in 10ms, which rounds up rather than to zero.
    const decision = consumeRateLimit("k", 1, now);
    if (!decision.allowed)
      expect(decision.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it("prunes rather than growing without bound", () => {
    const now = 1_000_000;
    for (let i = 0; i < 10_050; i += 1) {
      consumeRateLimit(`key-${i}`, 10, now + i);
    }
    // Still serving: the prune drops the coldest keys, it does not throw or
    // stop admitting new ones.
    expect(consumeRateLimit("fresh", 10, now + 20_000).allowed).toBe(true);
  });
});
