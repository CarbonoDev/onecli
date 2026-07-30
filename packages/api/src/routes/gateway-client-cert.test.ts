import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level tests for `POST /gateway/client-cert` (mounted at
 * `/v1/gateway/client-cert` in the full app). Focus: the auth boundary (no
 * session/API key -> 401, before any minting work happens), and that
 * `withAudit` is called with the right action/service and metadata that
 * never carries cert/key material — the property CLAUDE.md's audit-logging
 * section requires ("Never include sensitive values").
 *
 * `../lib/gateway-client-cert` is mocked so this never makes a real network
 * call to a gateway; `../middleware/auth` is replaced with a minimal stub
 * gated on a test-only header, so the 401 case exercises a REAL "no auth
 * context reaches the handler" path rather than assuming the real
 * session/API-key resolution would 401 (that's `middleware/auth.test.ts`'s
 * job).
 */

interface FakeClientHostRow {
  id: string;
  projectId: string;
  organizationId?: string;
  label?: string;
  spiffeUri: string;
}

const state = vi.hoisted(() => ({
  auditRows: [] as Record<string, unknown>[],
  mintCalls: [] as Record<string, unknown>[],
  clientHosts: [] as FakeClientHostRow[],
  clientHostUpdates: [] as Record<string, unknown>[],
}));

vi.mock("@onecli/db", () => ({
  Prisma: { JsonNull: null },
  db: {
    clientHost: {
      create: async (args: { data: FakeClientHostRow }) => {
        state.clientHosts.push({ ...args.data });
        return { id: args.data.id, spiffeUri: args.data.spiffeUri };
      },
      // Tenant-scoped lookup — mirrors the real Prisma query exactly
      // (`where: { id, projectId }`): a row belonging to a DIFFERENT
      // projectId is indistinguishable from "doesn't exist" here, same as
      // in Postgres, which is the property the IDOR guard depends on.
      findFirst: async (args: {
        where: { id: string; projectId: string };
        select?: unknown;
      }) => {
        const found = state.clientHosts.find(
          (h) => h.id === args.where.id && h.projectId === args.where.projectId,
        );
        return found ? { id: found.id, spiffeUri: found.spiffeUri } : null;
      },
      update: async (args: Record<string, unknown>) => {
        state.clientHostUpdates.push(args);
        return {};
      },
    },
    auditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        state.auditRows.push(args.data);
        return {};
      },
    },
    apiKey: {
      findFirst: async () => null,
      findMany: async () => [],
    },
  },
}));

vi.mock("../lib/gateway-client-cert", () => ({
  mintClientCert: async (params: Record<string, unknown>) => {
    state.mintCalls.push(params);
    return {
      certPem: "LEAF-AND-CA-PEM",
      caPem: "CA-ONLY-PEM",
      serial: "abc123serial",
      notAfter: 1893456000,
    };
  },
}));

vi.mock("../middleware/auth", () => ({
  authMiddleware: async (
    c: {
      req: { header: (name: string) => string | undefined };
      set: (key: string, value: unknown) => void;
      json: (body: unknown, status: number) => Response;
    },
    next: () => Promise<void>,
  ) => {
    if (c.req.header("x-test-authed") !== "yes") {
      return c.json(
        {
          error: {
            message: "Invalid API key or token.",
            type: "authentication_error",
          },
        },
        401,
      );
    }
    c.set("auth", {
      userId: "user-1",
      userEmail: "guy@acme.com",
      organizationId: "org-1",
      projectId: "proj-1",
    });
    return next();
  },
  requireProjectId: (auth: { projectId?: string }) => {
    if (!auth.projectId) throw new Error("no project");
    return auth.projectId;
  },
}));

import { errorHandler } from "../middleware/error-handler";
import { clientCertRoutes } from "./gateway";

const VALID_CSR =
  "-----BEGIN CERTIFICATE REQUEST-----\nMIIBazCB7QIBADAA\n-----END CERTIFICATE REQUEST-----\n";

// `clientCertRoutes()` on its own has no error boundary — that's registered
// once on the root app in `app.ts` (`app.onError(errorHandler)`). Attach the
// same handler here so a thrown `ServiceError` (e.g. a validation failure)
// maps to its real status code instead of Hono's generic 500.
const app = clientCertRoutes();
app.onError(errorHandler);

const post = (body: unknown, authed: boolean) =>
  app.request("/client-cert", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authed ? { "x-test-authed": "yes" } : {}),
    },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  state.auditRows = [];
  state.mintCalls = [];
  state.clientHosts = [];
  state.clientHostUpdates = [];
});

describe("POST /gateway/client-cert", () => {
  it("401s without auth, before any minting work happens", async () => {
    const res = await post({ csrPem: VALID_CSR }, false);
    expect(res.status).toBe(401);
    expect(state.mintCalls).toHaveLength(0);
    expect(state.clientHosts).toHaveLength(0);
    expect(state.auditRows).toHaveLength(0);
  });

  it("400s on a body missing csrPem", async () => {
    const res = await post({ label: "no-csr" }, true);
    expect(res.status).toBe(400);
    expect(state.mintCalls).toHaveLength(0);
  });

  it("400s on a body carrying a key field instead of/alongside a CSR", async () => {
    const res = await post(
      {
        csrPem: VALID_CSR,
        keyPem: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
      },
      true,
    );
    expect(res.status).toBe(400);
    expect(state.mintCalls).toHaveLength(0);
  });

  it("mints, audits ISSUE/client-cert with no key material, and returns the expected shape", async () => {
    const res = await post({ csrPem: VALID_CSR, label: "ci-runner-1" }, true);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      identity: string;
      hostId: string;
      certPem: string;
      caPem: string;
      serial: string;
      notAfter: number;
    };
    expect(body.certPem).toBe("LEAF-AND-CA-PEM");
    expect(body.caPem).toBe("CA-ONLY-PEM");
    expect(body.serial).toBe("abc123serial");
    expect(body.notAfter).toBe(1893456000);
    expect(body.identity).toMatch(/^spiffe:\/\/onecli\/host\/.+/);
    expect(body.hostId).toBeTruthy();
    // No key field anywhere in the response.
    expect(Object.keys(body).sort()).toEqual(
      ["caPem", "certPem", "hostId", "identity", "notAfter", "serial"].sort(),
    );

    expect(state.mintCalls).toHaveLength(1);
    expect(state.mintCalls[0]).toMatchObject({
      hostId: body.hostId,
      spiffeUri: body.identity,
      // The schema trims csrPem — assert against the trimmed form.
      csrPem: VALID_CSR.trim(),
    });

    expect(state.auditRows).toHaveLength(1);
    const audit = state.auditRows[0] as {
      action: string;
      service: string;
      userId: string;
      userEmail: string;
      projectId: string;
      organizationId: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("issue");
    expect(audit.service).toBe("client-cert");
    expect(audit.userId).toBe("user-1");
    expect(audit.userEmail).toBe("guy@acme.com");
    expect(audit.projectId).toBe("proj-1");
    expect(audit.organizationId).toBe("org-1");

    // The metadata guideline from CLAUDE.md: resource identifiers only, never
    // cert/key material. Assert both the exact shape AND (belt-and-braces)
    // that no PEM-looking string ever made it into the metadata blob.
    expect(audit.metadata).toEqual({
      hostId: body.hostId,
      spiffeUri: body.identity,
      serial: "abc123serial",
      notAfter: 1893456000,
    });
    expect(JSON.stringify(audit.metadata)).not.toContain("PEM");
    expect(JSON.stringify(audit.metadata)).not.toContain("PRIVATE KEY");

    // The ClientHost row was stamped with the mint's serial after issuance.
    expect(state.clientHostUpdates).toHaveLength(1);
  });

  // ── FIX 1: ClientHost is per-HOST, not per-enrollment call ────────────

  it("first enrollment (no hostId) creates a new host", async () => {
    const res = await post({ csrPem: VALID_CSR, label: "relay-1" }, true);
    expect(res.status).toBe(200);
    expect(state.clientHosts).toHaveLength(1);

    const body = (await res.json()) as { hostId: string; identity: string };
    expect(state.clientHosts[0]?.id).toBe(body.hostId);
    expect(state.clientHosts[0]?.spiffeUri).toBe(body.identity);
  });

  it("omitting hostId always creates a NEW host, even for the same caller", async () => {
    await post({ csrPem: VALID_CSR }, true);
    await post({ csrPem: VALID_CSR }, true);
    expect(state.clientHosts).toHaveLength(2);
    expect(state.clientHosts[0]?.id).not.toBe(state.clientHosts[1]?.id);
  });

  it("renewal with the caller's own hostId reuses the same identity (no new row)", async () => {
    const first = await post({ csrPem: VALID_CSR, label: "relay-1" }, true);
    const firstBody = (await first.json()) as {
      hostId: string;
      identity: string;
    };
    expect(state.clientHosts).toHaveLength(1);

    const renewed = await post(
      { csrPem: VALID_CSR, hostId: firstBody.hostId },
      true,
    );
    expect(renewed.status).toBe(200);
    const renewedBody = (await renewed.json()) as {
      hostId: string;
      identity: string;
    };

    expect(renewedBody.hostId).toBe(firstBody.hostId);
    expect(renewedBody.identity).toBe(firstBody.identity);
    // Still exactly one row — the renewal reused it, it didn't create a
    // second one.
    expect(state.clientHosts).toHaveLength(1);
    expect(state.mintCalls).toHaveLength(2);
    expect(state.clientHostUpdates).toHaveLength(2);
  });

  // IDOR guard: an authenticated caller in one project must not be able to
  // reuse (or even learn the existence of) a ClientHost row that belongs to
  // a DIFFERENT project by guessing/supplying its hostId.
  it("renewal with another tenant's hostId is rejected — never falls through to creating a new row", async () => {
    state.clientHosts.push({
      id: "11111111-1111-4111-8111-111111111111",
      projectId: "some-other-tenants-project",
      spiffeUri: "spiffe://onecli/host/11111111-1111-4111-8111-111111111111",
    });

    const res = await post(
      { csrPem: VALID_CSR, hostId: "11111111-1111-4111-8111-111111111111" },
      true,
    );

    expect(res.status).toBe(404);
    expect(state.mintCalls).toHaveLength(0);
    expect(state.auditRows).toHaveLength(0);
    // No fallback create happened — still just the one seeded (other
    // tenant's) row.
    expect(state.clientHosts).toHaveLength(1);
  });

  it("renewal with a hostId that doesn't exist at all is rejected the same way", async () => {
    const res = await post(
      { csrPem: VALID_CSR, hostId: "22222222-2222-4222-8222-222222222222" },
      true,
    );
    expect(res.status).toBe(404);
    expect(state.mintCalls).toHaveLength(0);
    expect(state.clientHosts).toHaveLength(0);
  });
});
