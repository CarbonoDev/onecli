import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem-slim";
});

const calls = {
  findMany: [] as Record<string, unknown>[],
  deleteMany: [] as Record<string, unknown>[],
  updateMany: [] as Record<string, unknown>[],
};
let matches: { id: string }[] = [];

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    webhookDelivery: {
      findMany: async (args: Record<string, unknown>) => {
        calls.findMany.push(args);
        return matches;
      },
      deleteMany: async (args: Record<string, unknown>) => {
        calls.deleteMany.push(args);
        return { count: matches.length };
      },
      updateMany: async (args: Record<string, unknown>) => {
        calls.updateMany.push(args);
        return { count: 2 };
      },
    },
  },
}));

import {
  maybeSweep,
  resetSweepThrottle,
  sweepWebhookDeliveries,
} from "./webhook-retention-service";

const NOW = Date.parse("2026-08-05T12:00:00Z");

const whereOf = (index: number) =>
  calls.findMany[index]?.where as Record<string, unknown>;

beforeEach(() => {
  calls.findMany.length = 0;
  calls.deleteMany.length = 0;
  calls.updateMany.length = 0;
  matches = [];
  resetSweepThrottle();
});

describe("sweepWebhookDeliveries", () => {
  it("expires deliveries that burned every attempt", async () => {
    const stats = await sweepWebhookDeliveries(NOW);
    expect(stats.expired).toBe(2);

    const update = calls.updateMany[0];
    expect(update?.where).toMatchObject({
      status: "pending",
      attempts: { gte: 5 },
    });
    expect(update?.data).toMatchObject({
      status: "failed",
      claimId: null,
      lastError: "exceeded max delivery attempts",
    });
  });

  it("applies a different window per status", async () => {
    await sweepWebhookDeliveries(NOW);

    const cutoff = (index: number) =>
      ((whereOf(index).createdAt as { lt: Date }).lt.getTime() - NOW) /
      -86_400_000;

    expect(whereOf(0)).toMatchObject({ status: "delivered" });
    expect(cutoff(0)).toBe(7);

    // Rejected rows are unauthenticated writes — the shortest window of all.
    expect(whereOf(1)).toMatchObject({
      status: "discarded",
      discardReason: "rejected",
    });
    expect(cutoff(1)).toBe(1);

    expect(whereOf(2)).toMatchObject({
      status: "discarded",
      discardReason: { not: "rejected" },
    });
    expect(cutoff(2)).toBe(7);

    expect(whereOf(3)).toMatchObject({ status: "failed" });
    expect(cutoff(3)).toBe(30);

    expect(whereOf(4)).toMatchObject({ status: "pending" });
    expect(cutoff(4)).toBe(30);
  });

  // deleteMany has no LIMIT, so the ids are selected first and deleted by id.
  it("deletes in bounded batches by id", async () => {
    matches = [{ id: "a" }, { id: "b" }];
    await sweepWebhookDeliveries(NOW);

    expect(calls.findMany[0]).toMatchObject({ take: 5_000 });
    expect(calls.deleteMany[0]?.where).toEqual({ id: { in: ["a", "b"] } });
  });

  it("stops after a bounded number of passes", async () => {
    // A full batch every time would loop forever without the pass cap.
    matches = Array.from({ length: 5_000 }, (_, i) => ({ id: `d-${i}` }));
    await sweepWebhookDeliveries(NOW);
    // 5 rules × at most 5 passes each.
    expect(calls.findMany.length).toBeLessThanOrEqual(25);
  });
});

describe("maybeSweep", () => {
  it("runs once per interval, not once per delivery", async () => {
    maybeSweep(NOW);
    await Promise.resolve();
    const afterFirst = calls.findMany.length;
    expect(afterFirst).toBeGreaterThan(0);

    maybeSweep(NOW + 1_000);
    maybeSweep(NOW + 60_000);
    await Promise.resolve();
    expect(calls.findMany.length).toBe(afterFirst);

    maybeSweep(NOW + 16 * 60_000);
    await Promise.resolve();
    expect(calls.findMany.length).toBeGreaterThan(afterFirst);
  });
});
