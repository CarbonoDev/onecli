import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * The delivery pull queue on REAL PostgreSQL.
 *
 * This is the one part of the webhook feature that mocks cannot prove. The
 * claim's correctness rests on Postgres re-evaluating a guarded `UPDATE`'s
 * `WHERE` against the committed row version under READ COMMITTED — a mocked
 * `updateMany` returns whatever the mock decides and would happily "pass" a
 * broken claim. So: two pollers race for real rows, and the assertion is that
 * every delivery is claimed exactly once.
 *
 * Env-gated like the other proof suites (skips locally, throws in CI); see
 * `testing/pg-proof.ts`.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type Queue = typeof import("./webhook-queue-service");

let db: Db;
let queue: Queue;

const P = "whq-";
const ORG = `${P}org`;
const PROJECT = `${P}proj`;
const AGENT = `${P}agent`;
const OTHER_AGENT = `${P}agent-other`;
const ENDPOINT = `${P}endpoint`;

const agentRef = { id: AGENT, identifier: AGENT };

const claimArgs = (
  over: Partial<Parameters<Queue["claimPending"]>[0]> = {},
) => ({
  agentId: AGENT,
  agent: agentRef,
  claimedBy: "test",
  batchSize: 25,
  leaseSec: 60,
  includePayload: false,
  ...over,
});

const reset = async () => {
  await db.webhookDelivery.deleteMany({ where: { projectId: PROJECT } });
  await db.webhookEndpoint.deleteMany({ where: { projectId: PROJECT } });
  await db.agent.deleteMany({ where: { id: { startsWith: P } } });
  await db.project.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
};

const seedDelivery = async (
  over: Record<string, unknown> = {},
): Promise<string> => {
  const row = await db.webhookDelivery.create({
    data: {
      projectId: PROJECT,
      endpointId: ENDPOINT,
      agentId: AGENT,
      status: "pending",
      headers: {},
      bodyBytes: 2,
      payload: { hello: "world" },
      renderedText: "hello",
      ...over,
    },
    select: { id: true },
  });
  return row.id;
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  ({ db } = await import("@onecli/db"));
  queue = await import("./webhook-queue-service");
  await reset();

  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.project.create({
    data: { id: PROJECT, name: PROJECT, organizationId: ORG },
  });
  for (const id of [AGENT, OTHER_AGENT]) {
    await db.agent.create({
      data: {
        id,
        projectId: PROJECT,
        name: id,
        identifier: id,
        accessToken: `aoc_${id}`,
        secretMode: "selective",
      },
    });
  }
  await db.webhookEndpoint.create({
    data: {
      id: ENDPOINT,
      projectId: PROJECT,
      publicId: "whe_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      slug: "whq-hook",
      name: "queue proof",
      verification: "none",
      template: "",
      agentId: AGENT,
      routing: { mode: "lane" },
    },
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await db.webhookDelivery.deleteMany({ where: { projectId: PROJECT } });
});

describe.skipIf(!PROOF_URL)("webhook queue on postgres", () => {
  // THE test. Everything else in this suite is a corollary.
  it("claims every delivery exactly once under concurrent pollers", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20; i += 1) ids.add(await seedDelivery());

    const claims = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        queue.claimPending(
          claimArgs({ claimedBy: `poller-${n}`, batchSize: 10 }),
        ),
      ),
    );

    const claimed = claims
      .filter((claim) => claim !== null)
      .flatMap((claim) => claim.deliveries.map((delivery) => delivery.id));

    // No delivery handed to two pollers…
    expect(new Set(claimed).size).toBe(claimed.length);
    // …and every claim carries its own batch token.
    const claimIds = claims.filter(Boolean).map((claim) => claim?.claimId);
    expect(new Set(claimIds).size).toBe(claimIds.length);

    // A second sweep drains whatever the first round's batch caps left behind.
    for (let round = 0; round < 4; round += 1) {
      const more = await queue.claimPending(claimArgs());
      if (!more) break;
      for (const delivery of more.deliveries) claimed.push(delivery.id);
    }
    expect(new Set(claimed)).toEqual(ids);
  });

  it("hands a lapsed lease to the next poller and staleness to the first", async () => {
    const id = await seedDelivery();

    const first = await queue.claimPending(claimArgs({ leaseSec: 60 }));
    expect(first?.deliveries.map((d) => d.id)).toEqual([id]);

    // Nothing to claim while the lease holds.
    expect(await queue.claimPending(claimArgs())).toBeNull();

    // Expire it the way time would.
    await db.webhookDelivery.update({
      where: { id },
      data: { availableAt: new Date(Date.now() - 1_000) },
    });

    const second = await queue.claimPending(
      claimArgs({ claimedBy: "poller-2" }),
    );
    expect(second?.deliveries.map((d) => d.id)).toEqual([id]);

    // The first poller's ack is now against a claim it no longer holds. It must
    // learn that rather than believe its work landed.
    const outcomes = await queue.ackDeliveries({
      agentId: AGENT,
      claimId: first!.claimId!,
      results: [{ id, status: "ok", retryable: true }],
    });
    expect(outcomes).toEqual([{ id, outcome: "stale" }]);

    // And the row is still the second poller's to complete.
    const ok = await queue.ackDeliveries({
      agentId: AGENT,
      claimId: second!.claimId!,
      results: [{ id, status: "ok", retryable: true }],
    });
    expect(ok).toEqual([{ id, outcome: "delivered" }]);
  });

  it("walks attempts up and drops the row out of the claim predicate", async () => {
    const id = await seedDelivery();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const claim = await queue.claimPending(claimArgs());
      expect(claim?.deliveries[0]?.attempt).toBe(attempt);
      // Simulate a consumer that died mid-dispatch: never acks, lease lapses.
      await db.webhookDelivery.update({
        where: { id },
        data: { availableAt: new Date(Date.now() - 1_000) },
      });
    }

    // Six is past QUEUE_MAX_ATTEMPTS: the row is no longer claimable, and the
    // retention sweep is what will mark it failed.
    expect(await queue.claimPending(claimArgs())).toBeNull();
    const row = await db.webhookDelivery.findUnique({ where: { id } });
    expect(row?.attempts).toBe(5);
    expect(row?.status).toBe("pending");
  });

  it("never hands one agent another agent's deliveries", async () => {
    const mine = await seedDelivery();
    await seedDelivery({ agentId: OTHER_AGENT });

    const claim = await queue.claimPending(claimArgs());
    expect(claim?.deliveries.map((d) => d.id)).toEqual([mine]);
  });

  it("requeues a retryable nack behind fresher work", async () => {
    const first = await seedDelivery();
    const claim = await queue.claimPending(claimArgs());

    await queue.ackDeliveries({
      agentId: AGENT,
      claimId: claim!.claimId!,
      results: [
        { id: first, status: "error", error: "lane offline", retryable: true },
      ],
    });

    const row = await db.webhookDelivery.findUnique({ where: { id: first } });
    expect(row?.status).toBe("pending");
    expect(row?.claimId).toBeNull();
    expect(row?.lastError).toBe("lane offline");
    // Pushed into the future, so it does not head-of-line block the queue.
    expect(row!.availableAt.getTime()).toBeGreaterThan(Date.now());

    // A delivery that arrives now is served first.
    const second = await seedDelivery();
    const next = await queue.claimPending(claimArgs());
    expect(next?.deliveries.map((d) => d.id)).toEqual([second]);
  });

  it("fails a non-retryable nack immediately", async () => {
    const id = await seedDelivery();
    const claim = await queue.claimPending(claimArgs());

    const outcomes = await queue.ackDeliveries({
      agentId: AGENT,
      claimId: claim!.claimId!,
      results: [
        {
          id,
          status: "error",
          error: "invalid_routing: mode must be lane or chat",
          retryable: false,
        },
      ],
    });

    expect(outcomes[0]?.outcome).toBe("failed");
    const row = await db.webhookDelivery.findUnique({ where: { id } });
    expect(row?.status).toBe("failed");
    expect(await queue.claimPending(claimArgs())).toBeNull();
  });

  // Postgres treats NULLs as distinct in a unique index, which is exactly what
  // lets deliveries from a provider that sends no delivery id coexist.
  it("allows many deliveries with no dedupe key on one endpoint", async () => {
    await seedDelivery({ dedupeKey: null });
    await seedDelivery({ dedupeKey: null });
    await seedDelivery({ dedupeKey: "gh-1" });

    await expect(seedDelivery({ dedupeKey: "gh-1" })).rejects.toThrow();
    expect(
      await db.webhookDelivery.count({ where: { endpointId: ENDPOINT } }),
    ).toBe(3);
  });
});
