/**
 * Delivery-log retention.
 *
 * There is no scheduler in this deployment — `docker/entrypoint.sh` runs Next
 * and the Rust gateway, nothing else — so the sweep is opportunistic: the
 * ingest path fires `maybeSweep()` at most once per interval per process, and
 * an operator (or an external scheduler) can force one through
 * `POST /v1/internal/webhooks/sweep`.
 *
 * Duplicate work across replicas is harmless: every delete is id-scoped and
 * idempotent.
 */

import { db } from "@onecli/db";

import { logger } from "../lib/logger";
import {
  DELIVERY_STATUS,
  DISCARD_REASON,
  QUEUE_MAX_ATTEMPTS,
  RETAIN_DELIVERED_DAYS,
  RETAIN_DISCARDED_DAYS,
  RETAIN_FAILED_DAYS,
  RETAIN_PENDING_DAYS,
  RETAIN_REJECTED_DAYS,
  SWEEP_BATCH,
  SWEEP_INTERVAL_MS,
  SWEEP_MAX_PASSES,
} from "./webhook/constants";
import type { Prisma } from "@onecli/db";

const log = logger.child({ module: "webhook-retention" });

export interface SweepStats {
  deleted: number;
  expired: number;
}

const daysAgo = (days: number, now: number) =>
  new Date(now - days * 24 * 60 * 60 * 1000);

/**
 * `deleteMany` has no LIMIT, so each rule is drained in bounded batches:
 * select ids, delete by id, repeat. Keeps every statement short and avoids a
 * lock-escalating delete over a large range.
 */
const deleteInBatches = async (
  where: Prisma.WebhookDeliveryWhereInput,
): Promise<number> => {
  let deleted = 0;
  for (let pass = 0; pass < SWEEP_MAX_PASSES; pass += 1) {
    const rows = await db.webhookDelivery.findMany({
      where,
      select: { id: true },
      take: SWEEP_BATCH,
    });
    if (rows.length === 0) break;
    const result = await db.webhookDelivery.deleteMany({
      where: { id: { in: rows.map((row) => row.id) } },
    });
    deleted += result.count;
    if (rows.length < SWEEP_BATCH) break;
  }
  return deleted;
};

export const sweepWebhookDeliveries = async (
  now = Date.now(),
): Promise<SweepStats> => {
  // The one queue-state transition the sweep owns: a delivery that burned every
  // attempt (a consumer crashing mid-dispatch, over and over) has fallen out of
  // the claim predicate and would otherwise sit "pending" forever.
  const expired = await db.webhookDelivery.updateMany({
    where: {
      status: DELIVERY_STATUS.PENDING,
      attempts: { gte: QUEUE_MAX_ATTEMPTS },
      availableAt: { lte: new Date(now) },
    },
    data: {
      status: DELIVERY_STATUS.FAILED,
      claimId: null,
      lastError: "exceeded max delivery attempts",
    },
  });

  let deleted = 0;
  deleted += await deleteInBatches({
    status: DELIVERY_STATUS.DELIVERED,
    createdAt: { lt: daysAgo(RETAIN_DELIVERED_DAYS, now) },
  });
  // Rejected rows are writes from unauthenticated callers — keep them only long
  // enough to answer "why is GitHub seeing 401s?".
  deleted += await deleteInBatches({
    status: DELIVERY_STATUS.DISCARDED,
    discardReason: DISCARD_REASON.REJECTED,
    createdAt: { lt: daysAgo(RETAIN_REJECTED_DAYS, now) },
  });
  deleted += await deleteInBatches({
    status: DELIVERY_STATUS.DISCARDED,
    discardReason: { not: DISCARD_REASON.REJECTED },
    createdAt: { lt: daysAgo(RETAIN_DISCARDED_DAYS, now) },
  });
  deleted += await deleteInBatches({
    status: DELIVERY_STATUS.FAILED,
    createdAt: { lt: daysAgo(RETAIN_FAILED_DAYS, now) },
  });
  // Pending rows this old are dead: no consumer is ever going to claim them.
  deleted += await deleteInBatches({
    status: DELIVERY_STATUS.PENDING,
    createdAt: { lt: daysAgo(RETAIN_PENDING_DAYS, now) },
  });

  return { deleted, expired: expired.count };
};

let lastSweepAt = 0;

/** Fire-and-forget from the ingest path. Throttled, never awaited. */
export const maybeSweep = (now = Date.now()): void => {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  void sweepWebhookDeliveries(now).catch((err: unknown) => {
    log.error({ err }, "webhook retention sweep failed");
  });
};

/** Test seam. */
export const resetSweepThrottle = () => {
  lastSweepAt = 0;
};
