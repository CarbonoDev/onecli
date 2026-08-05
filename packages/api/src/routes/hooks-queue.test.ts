import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";

import type { ApiEnv } from "../types";

// Route tests for the consumer pull queue. The invariants: a poller can only
// ever drain its OWN queue, an empty queue and a full one have the same
// response shape, and a stale claim is loud.

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem-slim";
  process.env.SECRET_ENCRYPTION_KEY = "test-secret-encryption-key";
});

const AGENT_TOKEN = "aoc_agent_one";
const PROJECT_KEY = "oc_project_key";

const pending: Record<string, unknown>[] = [];
let updateManyCount = 1;
const calls = {
  findMany: [] as Record<string, unknown>[],
  updateMany: [] as Record<string, unknown>[],
};

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    agent: {
      findUnique: async ({ where }: { where: { accessToken: string } }) =>
        where.accessToken === AGENT_TOKEN
          ? {
              id: "agent-1",
              identifier: "triage-bot",
              projectId: "proj-1",
              project: { organizationId: "org-1" },
            }
          : null,
      findFirst: async ({
        where,
      }: {
        where: { identifier: string; projectId: string };
      }) =>
        where.identifier === "triage-bot"
          ? { id: "agent-1", identifier: "triage-bot", projectId: "proj-1" }
          : null,
    },
    apiKey: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === PROJECT_KEY
          ? {
              userId: "user-1",
              projectId: "proj-1",
              scope: "project",
              project: { organizationId: "org-1" },
            }
          : null,
    },
    user: { findUnique: async () => ({ email: "dev@example.com" }) },
    project: {
      findUnique: async () => ({ id: "proj-1", organizationId: "org-1" }),
      findFirst: async () => ({ id: "proj-1", organizationId: "org-1" }),
    },
    projectAccess: { findFirst: async () => ({ role: "owner" }) },
    organizationMember: {
      findUnique: async () => ({ role: "owner", status: "active" }),
    },
    webhookDelivery: {
      findMany: async (args: Record<string, unknown>) => {
        calls.findMany.push(args);
        const where = args.where as Record<string, unknown>;
        // The read-back is keyed on claimId; the candidate scan is not.
        if ("claimId" in where) return pending;
        return pending.map((row) => ({ id: row.id }));
      },
      updateMany: async (args: Record<string, unknown>) => {
        calls.updateMany.push(args);
        return { count: updateManyCount };
      },
      findFirst: async () => ({ attempts: 1 }),
    },
  },
}));

import { createApiApp } from "../app";

const nullSession = { getSession: async () => null };
let app: Hono<ApiEnv>;

const delivery = (id: string) => ({
  id,
  eventType: "issues.opened",
  renderedText: "opened acme/api#1",
  attempts: 1,
  receivedAt: new Date("2026-08-05T10:00:00Z"),
  dedupeKey: "gh-1",
  replayOfId: null,
  payload: { action: "opened" },
  endpoint: {
    id: "ep-1",
    slug: "gh-issues",
    name: "GitHub issues",
    routing: { mode: "lane", target: { lane: "triage" } },
  },
});

beforeEach(() => {
  app = createApiApp(nullSession) as unknown as Hono<ApiEnv>;
  pending.length = 0;
  calls.findMany.length = 0;
  calls.updateMany.length = 0;
  updateManyCount = 1;
});

const agentHeaders = { authorization: `Bearer ${AGENT_TOKEN}` };

describe("GET /v1/hooks/pending — auth", () => {
  it("401s with no credential", async () => {
    const res = await app.request("/v1/hooks/pending?wait=0");
    expect(res.status).toBe(401);
  });

  it("401s an unknown agent token", async () => {
    const res = await app.request("/v1/hooks/pending?wait=0", {
      headers: { authorization: "Bearer aoc_nope" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts an agent access token", async () => {
    const res = await app.request("/v1/hooks/pending?wait=0", {
      headers: agentHeaders,
    });
    expect(res.status).toBe(200);
  });

  // A project key must never implicitly drain "some" queue.
  it("400s a project key with no ?agent=", async () => {
    const res = await app.request("/v1/hooks/pending?wait=0", {
      headers: {
        authorization: `Bearer ${PROJECT_KEY}`,
        "x-project-id": "proj-1",
      },
    });
    expect(res.status).toBe(400);
  });

  it("accepts a project key naming an agent in its project", async () => {
    const res = await app.request("/v1/hooks/pending?wait=0&agent=triage-bot", {
      headers: {
        authorization: `Bearer ${PROJECT_KEY}`,
        "x-project-id": "proj-1",
      },
    });
    expect(res.status).toBe(200);
  });

  it("401s a project key naming an unknown agent", async () => {
    const res = await app.request("/v1/hooks/pending?wait=0&agent=ghost", {
      headers: {
        authorization: `Bearer ${PROJECT_KEY}`,
        "x-project-id": "proj-1",
      },
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /v1/hooks/pending — response", () => {
  it("returns 200 with an empty batch rather than 204", async () => {
    const res = await app.request("/v1/hooks/pending?wait=0", {
      headers: agentHeaders,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      claimId: null,
      leaseExpiresAt: null,
      deliveries: [],
    });
  });

  it("returns the delivery envelope with routing verbatim", async () => {
    pending.push(delivery("d-1"));
    const res = await app.request("/v1/hooks/pending?wait=0", {
      headers: agentHeaders,
    });
    const body = (await res.json()) as {
      claimId: string;
      deliveries: Record<string, unknown>[];
    };

    expect(body.claimId).toBeTruthy();
    expect(body.deliveries[0]).toMatchObject({
      id: "d-1",
      event: "issues.opened",
      text: "opened acme/api#1",
      routing: { mode: "lane", target: { lane: "triage" } },
      agent: { id: "agent-1", identifier: "triage-bot" },
      payloadOmitted: false,
    });
  });

  it("omits the payload when asked", async () => {
    pending.push(delivery("d-1"));
    const res = await app.request("/v1/hooks/pending?wait=0&include=none", {
      headers: agentHeaders,
    });
    const body = (await res.json()) as {
      deliveries: Record<string, unknown>[];
    };
    expect(body.deliveries[0]).not.toHaveProperty("payload");
    expect(body.deliveries[0]).toMatchObject({ payloadOmitted: true });
  });

  it("clamps an over-long wait rather than trusting the client", async () => {
    const res = await app.request("/v1/hooks/pending?wait=9999", {
      headers: agentHeaders,
    });
    expect(res.status).toBe(422);
  });

  it("clamps the batch size", async () => {
    const res = await app.request("/v1/hooks/pending?wait=0&max=999", {
      headers: agentHeaders,
    });
    expect(res.status).toBe(422);
  });

  it("never caches", async () => {
    const res = await app.request("/v1/hooks/pending?wait=0", {
      headers: agentHeaders,
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("the claim query shape", () => {
  it("repeats the full availability guard inside the update", async () => {
    pending.push(delivery("d-1"));
    await app.request("/v1/hooks/pending?wait=0", { headers: agentHeaders });

    const guard = calls.updateMany[0]?.where as Record<string, unknown>;
    expect(guard).toMatchObject({ status: "pending", agentId: "agent-1" });
    expect(guard).toHaveProperty("availableAt");
    expect(guard).toHaveProperty("attempts");
    const data = calls.updateMany[0]?.data as Record<string, unknown>;
    expect(data).toMatchObject({ attempts: { increment: 1 } });
  });

  // The regression this guards: reading back by the candidate id list would
  // hand a poller rows another poller had just claimed.
  it("reads the claimed set back by claimId", async () => {
    pending.push(delivery("d-1"));
    await app.request("/v1/hooks/pending?wait=0", { headers: agentHeaders });

    const readback = calls.findMany.at(-1)?.where as Record<string, unknown>;
    expect(readback).toHaveProperty("claimId");
    expect(readback).not.toHaveProperty("id");
  });

  it("returns an empty batch when the guarded update matches nothing", async () => {
    pending.push(delivery("d-1"));
    updateManyCount = 0;
    const res = await app.request("/v1/hooks/pending?wait=0", {
      headers: agentHeaders,
    });
    expect(await res.json()).toMatchObject({ deliveries: [] });
  });
});

describe("acking", () => {
  const claimId = "11111111-1111-4111-8111-111111111111";
  const deliveryId = "22222222-2222-4222-8222-222222222222";

  const ack = (body: unknown) =>
    app.request("/v1/hooks/ack", {
      method: "POST",
      headers: { ...agentHeaders, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("marks a delivery delivered", async () => {
    const res = await ack({
      claimId,
      results: [{ id: deliveryId, status: "ok" }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      acked: [{ id: deliveryId, outcome: "delivered" }],
    });
  });

  it("guards every write on id + agent + claim", async () => {
    await ack({ claimId, results: [{ id: deliveryId, status: "ok" }] });
    expect(calls.updateMany[0]?.where).toMatchObject({
      id: deliveryId,
      agentId: "agent-1",
      claimId,
      status: "pending",
    });
  });

  it("requeues a retryable failure with a future availableAt", async () => {
    const res = await ack({
      claimId,
      results: [
        {
          id: deliveryId,
          status: "error",
          error: "lane offline",
          retryable: true,
        },
      ],
    });
    const body = (await res.json()) as { acked: Record<string, unknown>[] };
    expect(body.acked[0]).toMatchObject({ outcome: "requeued" });
    expect(
      new Date(body.acked[0]?.availableAt as string).getTime(),
    ).toBeGreaterThan(Date.now());
  });

  // A routing blob the consumer can't interpret fails identically forever;
  // spending five attempts on that certainty helps nobody.
  it("fails a non-retryable nack immediately", async () => {
    const res = await ack({
      claimId,
      results: [
        {
          id: deliveryId,
          status: "error",
          error: "invalid_routing: mode must be lane or chat",
          retryable: false,
        },
      ],
    });
    const body = (await res.json()) as { acked: Record<string, unknown>[] };
    expect(body.acked[0]).toMatchObject({ outcome: "failed" });
    expect(calls.updateMany[0]?.data).toMatchObject({ status: "failed" });
  });

  // 409, not 404: the poller must discard its work rather than assume it landed.
  it("409s when the whole batch is stale", async () => {
    updateManyCount = 0;
    const res = await ack({
      claimId,
      results: [{ id: deliveryId, status: "ok" }],
    });
    expect(res.status).toBe(409);
  });

  it("401s an ack with no credential", async () => {
    const res = await app.request("/v1/hooks/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        claimId,
        results: [{ id: deliveryId, status: "ok" }],
      }),
    });
    expect(res.status).toBe(401);
  });

  it("serves the single-delivery ack on its own path", async () => {
    const res = await app.request(`/v1/hooks/deliveries/${deliveryId}/ack`, {
      method: "POST",
      headers: { ...agentHeaders, "content-type": "application/json" },
      body: JSON.stringify({ claimId, status: "ok" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "delivered" });
  });
});
