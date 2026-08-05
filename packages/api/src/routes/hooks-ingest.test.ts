import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";

import type { ApiEnv } from "../types";

// Route tests for the ONE public, unauthenticated surface in the API. The
// invariants under test are the security ones: the verifier sees the exact
// bytes, nothing is written before verification succeeds, and no response
// leaks anything a caller shouldn't already know.

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem-slim";
  process.env.SECRET_ENCRYPTION_KEY = "test-secret-encryption-key";
});

const PUBLIC_ID = "whe_0123456789abcdef0123456789abcdef";
const SECRET = "whsec_test";
const ENCRYPTED = `enc:${SECRET}`;

interface EndpointOverrides {
  enabled?: boolean;
  verification?: string;
  secret?: string | null;
  template?: string;
  rateLimitPerMin?: number;
}

const endpointState: Required<EndpointOverrides> = {
  enabled: true,
  verification: "github",
  secret: ENCRYPTED,
  template: "{{action}} on {{repository.full_name}}",
  rateLimitPerMin: 1_000,
};

const created: Record<string, unknown>[] = [];
let createBehavior: "ok" | "duplicate" = "ok";

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
    Prisma: {
      PrismaClientKnownRequestError,
      JsonNull: null,
    },
    db: {
      webhookEndpoint: {
        findUnique: async ({ where }: { where: { publicId: string } }) =>
          where.publicId === PUBLIC_ID
            ? {
                id: "ep-1",
                projectId: "proj-1",
                agentId: "agent-1",
                slug: "gh-issues",
                ...endpointState,
              }
            : null,
        update: async () => ({}),
      },
      webhookDelivery: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          if (createBehavior === "duplicate") {
            throw new PrismaClientKnownRequestError("P2002", {
              target: "webhook_deliveries_endpoint_id_dedupe_key_key",
            });
          }
          created.push(data);
          return data;
        },
        findFirst: async () => ({ id: "existing-delivery" }),
        update: async () => ({}),
      },
    },
  };
});

// The one place a secret is decrypted. Asserting on this mock is how we prove
// the ingest path never reaches for lib/crypto directly.
const decrypt = vi.fn(async (value: string) => value.replace(/^enc:/, ""));
vi.mock("../providers", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getCrypto: () => ({ encrypt: async (v: string) => `enc:${v}`, decrypt }),
  };
});

import { createApiApp } from "../app";
import { resetRateLimits } from "../lib/rate-limit";

const nullSession = { getSession: async () => null };

const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex")}`;

let app: Hono<ApiEnv>;

const post = (
  body: string,
  headers: Record<string, string> = {},
  path = `/v1/hooks/${PUBLIC_ID}`,
) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });

const github = (body: string, extra: Record<string, string> = {}) =>
  post(body, {
    "x-hub-signature-256": sign(body),
    "x-github-event": "issues",
    "x-github-delivery": "gh-1",
    ...extra,
  });

beforeEach(() => {
  app = createApiApp(nullSession) as unknown as Hono<ApiEnv>;
  created.length = 0;
  createBehavior = "ok";
  decrypt.mockClear();
  resetRateLimits();
  Object.assign(endpointState, {
    enabled: true,
    verification: "github",
    secret: ENCRYPTED,
    template: "{{action}} on {{repository.full_name}}",
    rateLimitPerMin: 1_000,
  });
});

const BODY = '{"action":"opened","repository":{"full_name":"acme/api"}}';

describe("POST /v1/hooks/:publicId — happy path", () => {
  it("accepts a correctly signed delivery and queues it", async () => {
    const res = await github(BODY);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: "queued" });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      endpointId: "ep-1",
      agentId: "agent-1",
      status: "pending",
      eventType: "issues.opened",
      dedupeKey: "gh-1",
      renderedText: "opened on acme/api",
    });
  });

  it("stores only allow-listed headers", async () => {
    await github(BODY, {
      authorization: "Bearer super-secret",
      cookie: "session=abc",
    });
    const headers = created[0]?.headers as Record<string, string>;
    expect(headers).toHaveProperty("x-github-event");
    expect(headers).not.toHaveProperty("authorization");
    expect(headers).not.toHaveProperty("cookie");
    expect(headers).not.toHaveProperty("x-hub-signature-256");
  });

  it("decrypts the secret through the injected crypto provider", async () => {
    await github(BODY);
    expect(decrypt).toHaveBeenCalledWith(ENCRYPTED);
  });

  it("never echoes the secret or internal ids", async () => {
    const res = await github(BODY);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("ep-1");
    expect(text).not.toContain("agent-1");
  });

  it("accepts a form-encoded GitHub delivery", async () => {
    const form = `payload=${encodeURIComponent(BODY)}`;
    const res = await post(form, {
      "content-type": "application/x-www-form-urlencoded",
      "x-hub-signature-256": sign(form),
      "x-github-event": "issues",
    });
    expect(res.status).toBe(202);
    expect(created[0]).toMatchObject({ renderedText: "opened on acme/api" });
  });

  it("verifies the raw bytes, not a re-serialization", async () => {
    const spaced = '{ "action": "opened" }';
    const res = await post(spaced, {
      "x-hub-signature-256": sign(spaced),
      "x-github-event": "issues",
    });
    expect(res.status).toBe(202);
  });
});

describe("POST /v1/hooks/:publicId — rejections", () => {
  it("401s a tampered body and writes no queued row", async () => {
    const res = await post('{"action":"closed"}', {
      "x-hub-signature-256": sign(BODY),
      "x-github-event": "issues",
    });
    expect(res.status).toBe(401);
    expect(created.filter((row) => row.status === "pending")).toHaveLength(0);
  });

  it("records a rejected delivery without its payload", async () => {
    await post('{"action":"closed"}', {
      "x-hub-signature-256": sign(BODY),
      "x-github-event": "issues",
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      status: "discarded",
      discardReason: "rejected",
      lastError: "bad_signature",
    });
    expect(created[0]?.payload).toBeNull();
  });

  it("401s a missing signature", async () => {
    const res = await post(BODY, { "x-github-event": "issues" });
    expect(res.status).toBe(401);
  });

  it("404s an unknown endpoint", async () => {
    const other = "whe_ffffffffffffffffffffffffffffffff";
    const res = await post(BODY, {}, `/v1/hooks/${other}`);
    expect(res.status).toBe(404);
  });

  // The regex guard runs before any query, so a scanner costs nothing.
  it("404s a malformed public id without touching the database", async () => {
    const res = await post(BODY, {}, "/v1/hooks/not-a-hook");
    expect(res.status).toBe(404);
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("refuses an oversized content-length before reading the body", async () => {
    const res = await post(BODY, { "content-length": "99999999" });
    expect(res.status).toBe(413);
    expect(created).toHaveLength(0);
  });

  it("400s a valid signature over a non-JSON body", async () => {
    const notJson = "hello";
    const res = await post(notJson, {
      "x-hub-signature-256": sign(notJson),
      "x-github-event": "issues",
    });
    expect(res.status).toBe(400);
  });

  it("415s an unsupported content type", async () => {
    const res = await post(BODY, {
      "content-type": "application/octet-stream",
      "x-hub-signature-256": sign(BODY),
    });
    expect(res.status).toBe(415);
  });

  it("429s once the endpoint's rate limit is spent", async () => {
    endpointState.rateLimitPerMin = 1;
    expect((await github(BODY)).status).toBe(202);
    const res = await github(BODY);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });
});

describe("POST /v1/hooks/:publicId — non-queueing successes", () => {
  it("answers 200 and writes nothing when the endpoint is disabled", async () => {
    endpointState.enabled = false;
    const res = await github(BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reason: "disabled" });
    expect(created).toHaveLength(0);
  });

  it("records a ping as discarded rather than queueing it", async () => {
    const body = '{"zen":"Keep it logically awesome."}';
    const res = await post(body, {
      "x-hub-signature-256": sign(body),
      "x-github-event": "ping",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reason: "handshake" });
    expect(created[0]).toMatchObject({
      status: "discarded",
      discardReason: "handshake",
    });
  });

  // 2xx on a duplicate is the point: 4xx would make the provider retry the one
  // case retries exist for.
  it("answers 200 with the original id on a duplicate", async () => {
    createBehavior = "duplicate";
    const res = await github(BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "existing-delivery",
      status: "duplicate",
    });
  });

  it("accepts an unverified endpoint with no signature at all", async () => {
    endpointState.verification = "none";
    endpointState.secret = null;
    const res = await post(BODY);
    expect(res.status).toBe(202);
  });
});
