/**
 * The webhook delivery pull queue.
 *
 * A consumer with no inbound network path (an agent runtime on someone's VM)
 * long-polls for work, processes it, and acks. Everything hard about this file
 * is in three places: the atomic claim, the shape of the wait, and what an ack
 * is allowed to change.
 *
 * ## The claim is race-free without a transaction
 *
 * Candidates are selected, then a guarded `updateMany` repeats the SAME
 * availability predicate, then the claimed set is read back BY `claimId`.
 *
 * Two pollers can both see `{d1, d2}` in step 1 and both issue step 2. Postgres
 * serializes them on the row locks; under READ COMMITTED the loser re-evaluates
 * its `WHERE` against the committed row version, finds `availableAt` now in the
 * future, and skips the row — so it gets `count = 0` and its read-back, keyed
 * on its OWN fresh `claimId`, returns nothing. Correctness rests on exactly
 * two things:
 *
 *   (i)  the guard predicate is repeated inside the UPDATE, and
 *   (ii) `claimId` is a fresh uuid per claim, so a read-back can never pick up
 *        another poller's rows.
 *
 * Neither `SELECT … FOR UPDATE SKIP LOCKED` nor an explicit transaction is
 * needed, which keeps a claim to three short statements holding no long-lived
 * connection.
 *
 * ## Abandoned claims need no reaper
 *
 * Claiming pushes `availableAt` to now + lease. A poller that dies mid-batch
 * leaves rows that simply become claimable again when that passes. `attempts`
 * was already incremented at claim time, so a consumer that crashes on the same
 * delivery repeatedly walks up to `QUEUE_MAX_ATTEMPTS` and falls out of the
 * predicate for good; the retention sweep is what flips those to `failed`.
 *
 * ## The wait holds nothing
 *
 * `pollPending` sleeps BETWEEN queries, never inside one. It holds no claim, no
 * transaction and no pool connection, so a SIGTERM mid-wait loses nothing and N
 * parked pollers cost no connections. Do not move the sleep inside a
 * `$transaction`.
 */

import { randomUUID } from "node:crypto";

import { db, Prisma } from "@onecli/db";

import {
  ACK_ERROR_MAX_CHARS,
  DELIVERY_STATUS,
  ENVELOPE_PAYLOAD_MAX_BYTES,
  POLL_INTERVAL_MS,
  POLL_JITTER_MS,
  QUEUE_BACKOFF_BASE_MS,
  QUEUE_BACKOFF_MAX_MS,
  QUEUE_MAX_ATTEMPTS,
} from "./webhook/constants";
import { subscribePending } from "./webhook/notify";

export interface DeliveryEnvelope {
  id: string;
  endpoint: { id: string; slug: string; name: string };
  agent: { id: string; identifier: string };
  event: string | null;
  /** The rendered template — what the agent is meant to act on. */
  text: string;
  /** Verbatim from the endpoint. OneCLI never parses this. */
  routing: unknown;
  attempt: number;
  receivedAt: string;
  dedupeKey: string | null;
  replayOfId: string | null;
  payload?: unknown;
  payloadOmitted: boolean;
}

export interface ClaimResult {
  claimId: string | null;
  leaseExpiresAt: string | null;
  deliveries: DeliveryEnvelope[];
}

export const EMPTY_CLAIM: ClaimResult = {
  claimId: null,
  leaseExpiresAt: null,
  deliveries: [],
};

export interface ClaimArgs {
  agentId: string;
  /** Opaque poller identity, recorded for debugging. */
  claimedBy: string;
  batchSize: number;
  leaseSec: number;
  includePayload: boolean;
}

const ENVELOPE_SELECT = {
  id: true,
  eventType: true,
  renderedText: true,
  attempts: true,
  receivedAt: true,
  dedupeKey: true,
  replayOfId: true,
  payload: true,
  endpoint: { select: { id: true, slug: true, name: true, routing: true } },
} as const;

type EnvelopeRow = Prisma.WebhookDeliveryGetPayload<{
  select: typeof ENVELOPE_SELECT;
}>;

const toEnvelope = (
  row: EnvelopeRow,
  agent: { id: string; identifier: string },
  includePayload: boolean,
): DeliveryEnvelope => {
  // The poller holds an agent token, not an admin key, so it has no other way
  // to reach the payload — include it by default, and be explicit when a
  // pathological one is left out rather than silently sending `undefined`.
  const serialized = includePayload ? JSON.stringify(row.payload ?? null) : "";
  const omitted =
    !includePayload ||
    Buffer.byteLength(serialized, "utf8") > ENVELOPE_PAYLOAD_MAX_BYTES;

  return {
    id: row.id,
    endpoint: {
      id: row.endpoint.id,
      slug: row.endpoint.slug,
      name: row.endpoint.name,
    },
    agent,
    event: row.eventType,
    text: row.renderedText ?? "",
    routing: row.endpoint.routing ?? null,
    attempt: row.attempts,
    receivedAt: row.receivedAt.toISOString(),
    dedupeKey: row.dedupeKey,
    replayOfId: row.replayOfId,
    ...(omitted ? {} : { payload: row.payload }),
    payloadOmitted: omitted,
  };
};

export const claimPending = async (
  args: ClaimArgs & { agent: { id: string; identifier: string } },
  now = new Date(),
): Promise<ClaimResult | null> => {
  const { agentId, claimedBy, batchSize, leaseSec, includePayload } = args;
  const leaseExpiresAt = new Date(now.getTime() + leaseSec * 1000);

  // 1. Candidates. ADVISORY ONLY — never trusted as the claimed set.
  const candidates = await db.webhookDelivery.findMany({
    where: {
      agentId,
      status: DELIVERY_STATUS.PENDING,
      availableAt: { lte: now },
      attempts: { lt: QUEUE_MAX_ATTEMPTS },
    },
    orderBy: [{ availableAt: "asc" }, { id: "asc" }],
    take: batchSize,
    select: { id: true },
  });
  if (candidates.length === 0) return null;

  const claimId = randomUUID();

  // 2. THE atomic step. The guard repeats the full availability predicate, so a
  //    row another poller took between (1) and (2) does not match here.
  const { count } = await db.webhookDelivery.updateMany({
    where: {
      id: { in: candidates.map((row) => row.id) },
      // Redundant against the candidate scan — a delivery's agent never
      // changes — but it keeps the guard readable as a standalone statement.
      agentId,
      status: DELIVERY_STATUS.PENDING,
      availableAt: { lte: now },
      attempts: { lt: QUEUE_MAX_ATTEMPTS },
    },
    data: {
      claimId,
      claimedBy,
      claimedAt: now,
      // The visibility timeout: the row is invisible until the lease lapses.
      availableAt: leaseExpiresAt,
      attempts: { increment: 1 },
    },
  });
  if (count === 0) return null;

  // 3. Read back BY claimId — the only authoritative set.
  const rows = await db.webhookDelivery.findMany({
    where: { claimId },
    orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
    select: ENVELOPE_SELECT,
  });

  return {
    claimId,
    leaseExpiresAt: leaseExpiresAt.toISOString(),
    deliveries: rows.map((row) => toEnvelope(row, args.agent, includePayload)),
  };
};

/** Resolves on the timer, on a notification, or on abort — whichever is first. */
const sleepOrSignal = (
  agentId: string,
  ms: number,
  signal: AbortSignal,
): Promise<void> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener("abort", finish);
      resolve();
    };

    const timer = setTimeout(finish, ms);
    // Without this the resolver leaks on every hangup of a busy endpoint.
    const unsubscribe = subscribePending(agentId, finish);
    signal.addEventListener("abort", finish, { once: true });
  });

export const pollPending = async (
  args: ClaimArgs & {
    agent: { id: string; identifier: string };
    waitSec: number;
    signal: AbortSignal;
  },
): Promise<ClaimResult> => {
  const deadline = Date.now() + args.waitSec * 1000;

  for (;;) {
    const claim = await claimPending(args);
    if (claim) return claim;
    if (args.signal.aborted) return EMPTY_CLAIM;

    const remaining = deadline - Date.now();
    if (remaining <= 0) return EMPTY_CLAIM;

    await sleepOrSignal(
      args.agentId,
      Math.min(remaining, POLL_INTERVAL_MS + Math.random() * POLL_JITTER_MS),
      args.signal,
    );
  }
};

export type AckOutcomeKind = "delivered" | "requeued" | "failed" | "stale";

export interface AckOutcome {
  id: string;
  outcome: AckOutcomeKind;
  attempts?: number;
  availableAt?: string;
}

export interface AckResultInput {
  id: string;
  status: "ok" | "error";
  error?: string;
  /**
   * `false` means "this will fail identically forever" — a routing blob the
   * consumer cannot interpret, a target that does not exist. Those terminate
   * immediately as `failed` (still replayable once a human fixes the config)
   * rather than burning five attempts on a certainty.
   */
  retryable: boolean;
}

/** 30s, 1m, 2m, 4m … capped at 15m, ±20% jitter. */
export const backoffMs = (attempts: number, random = Math.random): number => {
  const base = Math.min(
    QUEUE_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1),
    QUEUE_BACKOFF_MAX_MS,
  );
  return Math.round(base * (0.8 + random() * 0.4));
};

const truncateError = (value: string | undefined): string | null =>
  value === undefined ? null : value.slice(0, ACK_ERROR_MAX_CHARS);

export const ackDeliveries = async (args: {
  agentId: string;
  claimId: string;
  results: AckResultInput[];
}): Promise<AckOutcome[]> => {
  const outcomes: AckOutcome[] = [];

  for (const result of args.results) {
    // Every write is guarded on the full triple. `count === 0` means the lease
    // lapsed and someone else holds the row — that is a stale ack, and the
    // caller must discard its work rather than assume it landed.
    const guard = {
      id: result.id,
      agentId: args.agentId,
      claimId: args.claimId,
      status: DELIVERY_STATUS.PENDING,
    };

    if (result.status === "ok") {
      const { count } = await db.webhookDelivery.updateMany({
        where: guard,
        data: {
          status: DELIVERY_STATUS.DELIVERED,
          deliveredAt: new Date(),
          claimId: null,
          lastError: null,
        },
      });
      outcomes.push({
        id: result.id,
        outcome: count === 1 ? "delivered" : "stale",
      });
      continue;
    }

    const row = await db.webhookDelivery.findFirst({
      where: guard,
      select: { attempts: true },
    });
    if (!row) {
      outcomes.push({ id: result.id, outcome: "stale" });
      continue;
    }

    const terminal = !result.retryable || row.attempts >= QUEUE_MAX_ATTEMPTS;
    const availableAt = terminal
      ? undefined
      : new Date(Date.now() + backoffMs(row.attempts));

    const { count } = await db.webhookDelivery.updateMany({
      // Re-guarded: the read above is advisory, the lease may have lapsed
      // between the two statements.
      where: guard,
      data: terminal
        ? {
            status: DELIVERY_STATUS.FAILED,
            claimId: null,
            lastError: truncateError(result.error),
          }
        : {
            availableAt,
            claimId: null,
            lastError: truncateError(result.error),
          },
    });

    if (count !== 1) {
      outcomes.push({ id: result.id, outcome: "stale" });
      continue;
    }

    outcomes.push({
      id: result.id,
      outcome: terminal ? "failed" : "requeued",
      attempts: row.attempts,
      ...(availableAt ? { availableAt: availableAt.toISOString() } : {}),
    });
  }

  return outcomes;
};
