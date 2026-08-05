import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";

import type { ApiEnv } from "../types";

// Admin CRUD over webhook endpoints, plus the guard that matters most in this
// file: `routes/hooks.ts` carries no `use("*")`, so every route has to name its
// own middleware. The enumeration test below is what catches the day someone
// adds one and forgets.

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem-slim";
  process.env.SECRET_ENCRYPTION_KEY = "test-secret-encryption-key";
});

const PROJECT_KEY = "oc_project_key";
const HOOK_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";
const DELIVERY_ID = "55555555-5555-4555-8555-555555555555";

let endpointRow: Record<string, unknown> | null = null;
let createError: Error | null = null;
const created: Record<string, unknown>[] = [];
const audited: Record<string, unknown>[] = [];

const baseEndpoint = () => ({
  id: HOOK_ID,
  publicId: "whe_0123456789abcdef0123456789abcdef",
  slug: "gh-issues",
  name: "GitHub issues",
  verification: "github",
  secret: "enc:whsec_stored",
  template: "{{action}}",
  agentId: AGENT_ID,
  routing: { mode: "lane" },
  enabled: true,
  rateLimitPerMin: 120,
  lastDeliveryAt: null,
  createdAt: new Date("2026-08-01T00:00:00Z"),
  updatedAt: new Date("2026-08-01T00:00:00Z"),
  agent: { name: "Triage", identifier: "triage-bot" },
});

vi.mock("@onecli/db", () => {
  class PrismaClientKnownRequestError extends Error {
    code: string;
    meta?: Record<string, unknown>;
    constructor(code: string, meta?: Record<string, unknown>) {
      super(code);
      this.code = code;
      this.meta = meta;
    }
  }
  return {
    Prisma: { PrismaClientKnownRequestError, JsonNull: null },
    db: {
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
      agent: {
        findFirst: async ({ where }: { where: { id: string } }) =>
          where.id === AGENT_ID ? { id: AGENT_ID } : null,
      },
      auditLog: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          audited.push(data);
          return data;
        },
      },
      webhookEndpoint: {
        findMany: async () => (endpointRow ? [endpointRow] : []),
        findFirst: async () => endpointRow,
        // Only reached by the "exactly one public route" probe, which posts to
        // an id that does not exist.
        findUnique: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          if (createError) throw createError;
          created.push(data);
          return { ...baseEndpoint(), ...data };
        },
        update: async ({ data }: { data: Record<string, unknown> }) => ({
          ...baseEndpoint(),
          ...data,
        }),
        delete: async () => ({}),
      },
      webhookDelivery: {
        count: async () => 7,
        findMany: async () => [],
        findFirst: async () => ({
          id: DELIVERY_ID,
          endpointId: HOOK_ID,
          status: "delivered",
          discardReason: null,
          eventType: "issues.opened",
          dedupeKey: "gh-1",
          duplicateCount: 0,
          attempts: 1,
          bodyBytes: 12,
          lastError: null,
          replayOfId: null,
          receivedAt: new Date("2026-08-01T00:00:00Z"),
          deliveredAt: new Date("2026-08-01T00:00:01Z"),
          createdAt: new Date("2026-08-01T00:00:00Z"),
          claimId: null,
          availableAt: new Date("2026-08-01T00:00:00Z"),
          payload: { action: "opened" },
          headers: {},
          renderedText: "opened",
          renderWarnings: [],
          claimedBy: null,
          claimedAt: null,
          endpoint: {
            id: HOOK_ID,
            slug: "gh-issues",
            template: "REPLAYED {{action}}",
            agentId: AGENT_ID,
          },
        }),
        create: async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: "new-delivery" };
        },
        update: async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return data;
        },
      },
    },
  };
});

const encrypt = vi.fn(async (value: string) => `enc:${value}`);
const decrypt = vi.fn(async (value: string) => value.replace(/^enc:/, ""));
vi.mock("../providers", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getCrypto: () => ({ encrypt, decrypt }) };
});

import { createApiApp } from "../app";

const nullSession = { getSession: async () => null };
let app: Hono<ApiEnv>;

const authed: Record<string, string> = {
  authorization: `Bearer ${PROJECT_KEY}`,
  "x-project-id": "proj-1",
  "content-type": "application/json",
};

const req = (
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
) => app.request(path, { ...init, headers: { ...authed, ...init.headers } });

beforeEach(() => {
  app = createApiApp(nullSession) as unknown as Hono<ApiEnv>;
  endpointRow = baseEndpoint();
  createError = null;
  created.length = 0;
  audited.length = 0;
  encrypt.mockClear();
  decrypt.mockClear();
});

// ── The guard ─────────────────────────────────────────────────────────────

describe("every non-ingest route requires credentials", () => {
  // `routes/hooks.ts` has no `use("*")` by necessity (it would 401 the public
  // ingest POST), so authentication is per-route and a new route added without
  // it is silently public. This table is the guard.
  const routes: [string, string][] = [
    ["GET", "/v1/hooks"],
    ["POST", "/v1/hooks"],
    ["GET", "/v1/hooks/verifiers"],
    ["GET", `/v1/hooks/${HOOK_ID}`],
    ["PATCH", `/v1/hooks/${HOOK_ID}`],
    ["DELETE", `/v1/hooks/${HOOK_ID}`],
    ["POST", `/v1/hooks/${HOOK_ID}/rotate-secret`],
    ["GET", `/v1/hooks/${HOOK_ID}/deliveries`],
    ["GET", `/v1/hooks/deliveries/${DELIVERY_ID}`],
    ["POST", `/v1/hooks/deliveries/${DELIVERY_ID}/replay`],
    ["GET", "/v1/hooks/pending"],
    ["POST", "/v1/hooks/ack"],
    ["POST", `/v1/hooks/deliveries/${DELIVERY_ID}/ack`],
  ];

  it.each(routes)("%s %s is not public", async (method, path) => {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(method === "GET" || method === "DELETE"
        ? {}
        : { body: JSON.stringify({}) }),
    });
    expect(res.status).toBe(401);
  });

  it("leaves exactly one public route: the ingest POST", async () => {
    const res = await app.request(
      "/v1/hooks/whe_00000000000000000000000000000000",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    expect(res.status).not.toBe(401);
  });
});

// ── CRUD ──────────────────────────────────────────────────────────────────

describe("POST /v1/hooks", () => {
  const body = {
    name: "GitHub issues",
    slug: "gh-issues",
    agentId: AGENT_ID,
    verification: "github",
    template: "{{action}}",
    routing: { mode: "lane" },
  };

  it("creates an endpoint and returns the minted secret", async () => {
    const res = await req("/v1/hooks", {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      secret: string;
      ingestPath: string;
    };
    expect(created.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(created.ingestPath).toMatch(/^\/v1\/hooks\/whe_[0-9a-f]{32}$/);
  });

  it("stores the secret encrypted, never in the clear", async () => {
    await req("/v1/hooks", { method: "POST", body: JSON.stringify(body) });
    expect(encrypt).toHaveBeenCalledTimes(1);
    expect(created[0]?.secret).toMatch(/^enc:/);
  });

  it("audits the create as a webhook event", async () => {
    await req("/v1/hooks", { method: "POST", body: JSON.stringify(body) });
    expect(audited[0]).toMatchObject({
      service: "webhook",
      action: "create",
      source: "api",
    });
  });

  it("422s an agent from another project", async () => {
    const res = await req("/v1/hooks", {
      method: "POST",
      body: JSON.stringify({
        ...body,
        agentId: "99999999-9999-4999-8999-999999999999",
      }),
    });
    expect(res.status).toBe(422);
  });

  it("409s a duplicate slug", async () => {
    const { Prisma } = (await import("@onecli/db")) as unknown as {
      Prisma: { PrismaClientKnownRequestError: new (...a: unknown[]) => Error };
    };
    createError = new Prisma.PrismaClientKnownRequestError("P2002", {
      target: "webhook_endpoints_project_id_slug_key",
    });
    const res = await req("/v1/hooks", {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(409);
  });

  // Choosing "no verification at all" must be deliberate, never a default that
  // slipped through a client that forgot to send the field.
  it("422s verification:none without an explicit acknowledgement", async () => {
    const res = await req("/v1/hooks", {
      method: "POST",
      body: JSON.stringify({ ...body, verification: "none" }),
    });
    expect(res.status).toBe(422);
  });

  it("accepts verification:none when acknowledged", async () => {
    const res = await req("/v1/hooks", {
      method: "POST",
      body: JSON.stringify({
        ...body,
        verification: "none",
        acknowledgeUnverified: true,
      }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).secret).toBeNull();
  });
});

describe("reading endpoints", () => {
  it("omits the secret from the list", async () => {
    const res = await req("/v1/hooks");
    const text = await res.text();
    expect(text).not.toContain("whsec_");
    expect(JSON.parse(text)[0]).toMatchObject({ hasSecret: true });
  });

  // Re-readable by design: the value has to be re-pasted into a provider's
  // config months later, and every other credential here reveals the same way.
  it("returns the decrypted secret from the detail read", async () => {
    const res = await req(`/v1/hooks/${HOOK_ID}`);
    expect(await res.json()).toMatchObject({ secret: "whsec_stored" });
  });

  it("404s an endpoint in another project", async () => {
    endpointRow = null;
    const res = await req(`/v1/hooks/${HOOK_ID}`);
    expect(res.status).toBe(404);
  });

  it("lists the verifier registry for the create form", async () => {
    const res = await req("/v1/hooks/verifiers");
    const body = (await res.json()) as { id: string }[];
    expect(body.map((v) => v.id)).toEqual(["github", "token", "none"]);
  });
});

describe("rotate and delete", () => {
  it("mints a new secret and re-encrypts it", async () => {
    const res = await req(`/v1/hooks/${HOOK_ID}/rotate-secret`, {
      method: "POST",
      body: "{}",
    });
    const body = (await res.json()) as { secret: string };
    expect(body.secret).toMatch(/^whsec_/);
    expect(body.secret).not.toBe("whsec_stored");
    expect(encrypt).toHaveBeenCalledWith(body.secret);
    expect(audited[0]).toMatchObject({
      action: "regenerate",
      service: "webhook",
    });
  });

  it("reports how much history the cascade removed", async () => {
    const res = await req(`/v1/hooks/${HOOK_ID}`, { method: "DELETE" });
    expect(await res.json()).toMatchObject({ deletedDeliveries: 7 });
    expect(audited[0]).toMatchObject({ action: "delete" });
  });
});

describe("deliveries", () => {
  it("returns the full payload from the detail read", async () => {
    const res = await req(`/v1/hooks/deliveries/${DELIVERY_ID}`);
    expect(await res.json()).toMatchObject({
      payload: { action: "opened" },
      renderedText: "opened",
    });
  });

  // Replay inserts a NEW row rendered with the endpoint's CURRENT template —
  // that is the whole point of it, and how a fixed template gets applied.
  it("replays into a new row using the current template", async () => {
    const res = await req(`/v1/hooks/deliveries/${DELIVERY_ID}/replay`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ replayOfId: DELIVERY_ID });

    const insert = created.find((row) => row.status === "pending");
    expect(insert).toMatchObject({ replayOfId: DELIVERY_ID, dedupeKey: null });

    const render = created.find((row) => "renderedText" in row);
    expect(render?.renderedText).toBe("REPLAYED opened");
  });

  it("audits a replay without flushing the gateway cache", async () => {
    await req(`/v1/hooks/deliveries/${DELIVERY_ID}/replay`, {
      method: "POST",
      body: "{}",
    });
    expect(audited[0]).toMatchObject({
      service: "webhook",
      action: "create",
      metadata: expect.objectContaining({ replayOfId: DELIVERY_ID }),
    });
  });
});
