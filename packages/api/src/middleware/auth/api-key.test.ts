import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { ApiEnv } from "../../types";

// API-key authentication under OSS + `CAPS.rbac`, through the REAL app: the
// real `auth()` middleware, the real `canAccessProjectAsUser` gate, and the
// real `ossRoleResolver` registered the way production registers it.
//
// This is the lockout regression suite for the rbac flip. The single most
// important case is the FIRST one: an ordinary single-user instance whose
// project predates ProjectAccess bindings must keep authenticating, because its
// user is the org owner. Everything else here is the other side of that coin —
// the gate must still say no to suspended, unknown-role and non-member users.
//
// The suite is written so it MUST FAIL if `ossRoleResolver` is swapped for a
// permissive stub like `{ getUserRole: async () => "owner" }`: the suspended-*,
// no-membership, unknown-role and org-key-member cases all depend on the real
// resolver returning null.

const USER = "user-1";
const ORG = "org-1";
const PROJECT = "proj-1";
const OTHER_PROJECT = "proj-2";
const PROJECT_KEY = "oc_project-key";
const ORG_KEY = "oc_org_key";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "oss";
  process.env.SECRET_ENCRYPTION_KEY = "test-secret";
  process.env.OAUTH_STATE_SECRET = "test-secret";
});

const state = vi.hoisted(() => ({
  /** The membership row the resolver reads; null = no row at all. */
  member: { role: "owner", status: "active" } as {
    role: string;
    status: string;
  } | null,
  /** Whether a ProjectAccess binding exists for the user on the project. */
  hasBinding: false,
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key?: string } }) => {
        if (where.key === "oc_org_key")
          return {
            userId: "user-1",
            organizationId: "org-1",
            scope: "organization",
          };
        if (where.key === "oc_project-key")
          return { userId: "user-1", projectId: "proj-1" };
        return null;
      },
      findFirst: async () => null,
      findMany: async () => [],
    },
    user: {
      findUnique: async () => ({ id: "user-1", email: "user@example.com" }),
    },
    organizationMember: {
      findUnique: async () => state.member,
      findFirst: async () =>
        state.member ? { organizationId: "org-1" } : null,
    },
    project: {
      findUnique: async ({ where }: { where: { id?: string } }) =>
        where.id === "proj-1"
          ? { id: "proj-1", organizationId: "org-1" }
          : null,
      findFirst: async ({ where }: { where?: { id?: string } }) =>
        where?.id === undefined || where.id === "proj-1"
          ? { id: "proj-1", organizationId: "org-1" }
          : null,
    },
    projectAccess: {
      findFirst: async () => (state.hasBinding ? { id: "binding-1" } : null),
    },
    agent: { findMany: async () => [] },
    // Upstream v1.45.0 gave listAgents a last-seen aggregate
    // (agent-service.ts -> db.requestLog.groupBy). No request history in these
    // fixtures, so every agent reads as "never used".
    requestLog: { groupBy: async () => [] },
  },
}));

import { createApiApp } from "../../app";
import { ossRoleResolver } from "../../services/org-role-resolver";
import { initStrictApiKeyAuth } from "../../providers";
import { auth } from "../auth";

// An echo route mounted on the same seam the OSS org routes use, so the
// resolved AuthContext (scope, role) is observable. `/v1/agents` below is the
// real project route; this only adds visibility.
const echoRoutes = (app: Hono<ApiEnv>) => {
  app.get("/echo/project", auth(), (c) => c.json(c.get("auth")));
  app.get("/echo/org", auth({ requireProject: false }), (c) =>
    c.json(c.get("auth")),
  );
};

const nullSession = { getSession: async () => null };

const app = createApiApp(nullSession, {
  roleResolver: ossRoleResolver,
  eeRoutes: echoRoutes,
});

const bearer = (key: string, extra: Record<string, string> = {}) => ({
  headers: { Authorization: `Bearer ${key}`, ...extra },
});

interface EchoBody {
  userId: string;
  projectId?: string;
  organizationId: string;
  scope?: string;
}

interface ErrorBody {
  error: { message: string; type: string };
}

beforeEach(() => {
  state.member = { role: "owner", status: "active" };
  state.hasBinding = false;
  initStrictApiKeyAuth(false);
});

describe("project API key under rbac", () => {
  it("authenticates the org OWNER with NO binding row (legacy-instance guard)", async () => {
    // The single-user OSS instance whose project predates ProjectAccess
    // bindings. If this ever fails, the rbac flip has bricked existing installs.
    state.member = { role: "owner", status: "active" };
    state.hasBinding = false;

    const res = await app.request("/v1/agents", bearer(PROJECT_KEY));
    expect(res.status).toBe(200);

    const echo = await app.request("/v1/echo/project", bearer(PROJECT_KEY));
    const body = (await echo.json()) as EchoBody;
    expect(body).toMatchObject({
      userId: USER,
      projectId: PROJECT,
      organizationId: ORG,
      scope: "project",
    });
  });

  it("authenticates an ADMIN with no binding (admins reach any project in the org)", async () => {
    state.member = { role: "admin", status: "active" };
    state.hasBinding = false;

    const res = await app.request("/v1/agents", bearer(PROJECT_KEY));
    expect(res.status).toBe(200);
  });

  it("rejects a plain MEMBER with no binding", async () => {
    state.member = { role: "member", status: "active" };
    state.hasBinding = false;

    const res = await app.request("/v1/agents", bearer(PROJECT_KEY));
    expect(res.status).toBe(401);
  });

  it("authenticates a plain MEMBER who holds a binding", async () => {
    state.member = { role: "member", status: "active" };
    state.hasBinding = true;

    const res = await app.request("/v1/agents", bearer(PROJECT_KEY));
    expect(res.status).toBe(200);
  });

  it.each(["owner", "admin", "member"])(
    "rejects a SUSPENDED %s even with a binding (suspension invariant)",
    async (role) => {
      state.member = { role, status: "suspended" };
      state.hasBinding = true;

      const res = await app.request("/v1/agents", bearer(PROJECT_KEY));
      expect(res.status).toBe(401);
    },
  );

  it("rejects a user with no membership row at all", async () => {
    state.member = null;
    state.hasBinding = true;

    const res = await app.request("/v1/agents", bearer(PROJECT_KEY));
    expect(res.status).toBe(401);
  });

  it("rejects an unrecognized role without throwing (401, never 500)", async () => {
    state.member = { role: "superadmin", status: "active" };
    state.hasBinding = true;

    const res = await app.request("/v1/agents", bearer(PROJECT_KEY));
    expect(res.status).toBe(401);
  });

  it("401s an unknown key with no session behind it (not a 500)", async () => {
    const res = await app.request("/v1/agents", bearer("oc_nope"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.type).toBe("authentication_error");
  });
});

describe("org API key under rbac", () => {
  it.each(["owner", "admin"])("authenticates an active %s", async (role) => {
    state.member = { role, status: "active" };

    const res = await app.request("/v1/echo/org", bearer(ORG_KEY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as EchoBody;
    expect(body).toMatchObject({ organizationId: ORG, scope: "organization" });
  });

  it("rejects a plain MEMBER (org keys are an admin capability)", async () => {
    state.member = { role: "member", status: "active" };

    const res = await app.request("/v1/echo/org", bearer(ORG_KEY));
    expect(res.status).toBe(401);
  });

  it("rejects a SUSPENDED admin", async () => {
    state.member = { role: "admin", status: "suspended" };

    const res = await app.request("/v1/echo/org", bearer(ORG_KEY));
    expect(res.status).toBe(401);
  });

  it("scopes a header-named project inside the key's org", async () => {
    state.member = { role: "admin", status: "active" };

    const res = await app.request(
      "/v1/echo/org",
      bearer(ORG_KEY, { "x-project-id": PROJECT }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as EchoBody;
    expect(body.projectId).toBe(PROJECT);
  });

  it("rejects a header project outside the key's org", async () => {
    state.member = { role: "admin", status: "active" };

    const res = await app.request(
      "/v1/echo/org",
      bearer(ORG_KEY, { "x-project-id": OTHER_PROJECT }),
    );
    expect(res.status).toBe(401);
  });

  // Strict mode makes the two rejection reasons distinguishable, which is the
  // only way to assert their ORDER: the admin re-check must run before the
  // missing-header complaint, so a demoted key holder is never told "just add a
  // project header".
  describe("strict API-key mode — sentinel ordering", () => {
    beforeEach(() => initStrictApiKeyAuth(true));

    it("asks an ADMIN for X-Project-Id on a project-scoped route", async () => {
      state.member = { role: "admin", status: "active" };

      const res = await app.request("/v1/agents", bearer(ORG_KEY));
      expect(res.status).toBe(401);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.message).toMatch(/X-Project-Id/);
    });

    it("tells a MEMBER the key is invalid, NOT to add a project header", async () => {
      state.member = { role: "member", status: "active" };

      const res = await app.request("/v1/agents", bearer(ORG_KEY));
      expect(res.status).toBe(401);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.message).not.toMatch(/X-Project-Id/);
    });
  });
});
