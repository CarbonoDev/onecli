import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../../types";

// `/v1/org/connections` end-to-end through the real app: OSS org routes on the
// `eeRoutes` seam, the OSS role resolver, admin callers with an ORG API key.
// Same harness shape as policy.test.ts / budgets.test.ts (cloned, not shared).
// The point of this router is WHICH rows it can see and reach: the org's own,
// and only those — `findOwnedConnection`'s ownership arms are the whole test.

const ORG = "org-1";
const OTHER_ORG = "org-2";
const PROJECT = "proj-1";
const ADMIN = "user-admin";
const MEMBER = "user-member";
const OUTSIDER = "user-outsider";
const OWNER = "user-owner";
const ADMIN_KEY = "oc_org_admin-key";
const OTHER_ADMIN_KEY = "oc_org_outsider-key";
const PROJECT_KEY = "oc_project-key-of-owner";

// `github` has no declared blocklist, so a disconnect never reaches the
// policy-rule sweep — this file's mock stays about connections.
const PROVIDER = "github";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "oss";
  process.env.SECRET_ENCRYPTION_KEY = `${"A".repeat(43)}=`;
  process.env.OAUTH_STATE_SECRET = "test-secret";
});

interface MemberRow {
  organizationId: string;
  userId: string;
  userEmail: string;
  role: string;
  status: string;
  ssoExempt: boolean;
  suspendedAt: Date | null;
  createdAt: Date;
}

interface UserRow {
  id: string;
  externalAuthId: string;
  email: string;
  name: string | null;
}

interface ConnectionRow {
  id: string;
  scope: string;
  projectId: string | null;
  organizationId: string | null;
  provider: string;
  label: string | null;
  status: string;
  scopes: string[];
  metadata: unknown;
  connectedAt: Date;
}

interface AuditRow {
  organizationId?: string;
  projectId?: string;
  userId: string;
  action: string;
  service: string;
  source: string;
  metadata: Record<string, unknown>;
}

interface ConnWhere {
  id?: string;
  provider?: string;
  projectId?: string;
  organizationId?: string;
  scope?: string;
  OR?: { projectId?: string; organizationId?: string; scope?: string }[];
}

const store = vi.hoisted(() => ({
  members: [] as MemberRow[],
  users: [] as UserRow[],
  connections: [] as ConnectionRow[],
  audits: [] as AuditRow[],
  sessionUserId: null as string | null,
}));

vi.mock("@onecli/db", () => {
  const findMember = (organizationId: string, userId: string) =>
    store.members.find(
      (m) => m.organizationId === organizationId && m.userId === userId,
    );

  const arm = (
    row: ConnectionRow,
    w: { projectId?: string; organizationId?: string; scope?: string },
  ) =>
    (w.projectId === undefined || row.projectId === w.projectId) &&
    (w.organizationId === undefined ||
      row.organizationId === w.organizationId) &&
    (w.scope === undefined || row.scope === w.scope);

  const matches = (row: ConnectionRow, where: ConnWhere) => {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.provider !== undefined && row.provider !== where.provider)
      return false;
    if (where.OR) return where.OR.some((w) => arm(row, w));
    return arm(row, where);
  };

  const db = {
    apiKey: {
      findUnique: async ({ where }: { where: { key?: string } }) => {
        if (where.key === ADMIN_KEY)
          return { userId: ADMIN, organizationId: ORG, scope: "organization" };
        if (where.key === OTHER_ADMIN_KEY)
          return {
            userId: OUTSIDER,
            organizationId: OTHER_ORG,
            scope: "organization",
          };
        if (where.key === PROJECT_KEY)
          return { userId: OWNER, projectId: PROJECT };
        return null;
      },
      findFirst: async () => null,
      findMany: async () => [],
    },
    user: {
      findUnique: async ({
        where,
        select,
      }: {
        where: { id?: string; externalAuthId?: string };
        select?: Record<string, unknown>;
      }) => {
        if (select?.organizationMemberships) {
          return {
            organizationMemberships: store.members
              .filter((m) => m.userId === where.id)
              .map((m) => ({ organizationId: m.organizationId })),
          };
        }
        return (
          store.users.find(
            (u) =>
              (where.id !== undefined && u.id === where.id) ||
              (where.externalAuthId !== undefined &&
                u.externalAuthId === where.externalAuthId),
          ) ?? null
        );
      },
    },
    organizationMember: {
      findUnique: async ({
        where,
      }: {
        where: {
          organizationId_userId: { organizationId: string; userId: string };
        };
      }) => {
        const { organizationId, userId } = where.organizationId_userId;
        return findMember(organizationId, userId) ?? null;
      },
      findFirst: async ({
        where,
      }: {
        where: { userId?: string; organizationId?: string };
      }) =>
        store.members.find(
          (m) =>
            (where.userId === undefined || m.userId === where.userId) &&
            (where.organizationId === undefined ||
              m.organizationId === where.organizationId) &&
            m.status === "active",
        ) ?? null,
      findMany: async () => [],
    },
    project: {
      findFirst: async () => ({ id: PROJECT, organizationId: ORG }),
      findUnique: async () => ({ id: PROJECT, organizationId: ORG }),
    },
    projectAccess: { findFirst: async () => null },
    appConnection: {
      findMany: async ({ where }: { where: ConnWhere }) =>
        store.connections
          .filter((c) => matches(c, where))
          .sort((a, b) => b.connectedAt.getTime() - a.connectedAt.getTime()),
      findFirst: async ({ where }: { where: ConnWhere }) =>
        store.connections.find((c) => matches(c, where)) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<ConnectionRow>;
      }) => {
        const row = store.connections.find((c) => c.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        store.connections = store.connections.filter((c) => c.id !== where.id);
        return {};
      },
      deleteMany: async () => ({ count: 0 }),
    },
    auditLog: {
      create: async ({ data }: { data: AuditRow }) => {
        store.audits.push(data);
        return data;
      },
    },
  };

  return { Prisma: { JsonNull: null }, db };
});

import { createApiApp } from "../../app";
import { registerOssOrgRoutes } from "./index";
import { ossRoleResolver } from "../../services/org-role-resolver";

const sessionProvider = {
  getSession: async () => {
    const user = store.users.find((u) => u.id === store.sessionUserId);
    return user ? { id: user.externalAuthId, email: user.email } : null;
  },
};

const app: Hono<ApiEnv> = createApiApp(sessionProvider, {
  eeRoutes: registerOssOrgRoutes,
  roleResolver: ossRoleResolver,
});

const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes));

const member = (
  userId: string,
  role: string,
  organizationId = ORG,
): MemberRow => ({
  organizationId,
  userId,
  userEmail: `${userId}@example.com`,
  role,
  status: "active",
  ssoExempt: false,
  suspendedAt: null,
  createdAt: at(0),
});

const connection = (
  id: string,
  overrides: Partial<ConnectionRow> = {},
): ConnectionRow => ({
  id,
  scope: "organization",
  projectId: null,
  organizationId: ORG,
  provider: PROVIDER,
  label: id,
  status: "connected",
  scopes: [],
  metadata: null,
  connectedAt: at(1),
  ...overrides,
});

const asAdmin = { headers: { Authorization: `Bearer ${ADMIN_KEY}` } };
const asOtherAdmin = {
  headers: { Authorization: `Bearer ${OTHER_ADMIN_KEY}` },
};
const asProjectKey = { headers: { Authorization: `Bearer ${PROJECT_KEY}` } };

interface ConnectionBody {
  id: string;
  label: string | null;
  scope: string;
}

const listOrg = async (init: RequestInit = asAdmin, query = "") => {
  const res = await app.request(`/v1/org/connections${query}`, init);
  expect(res.status).toBe(200);
  return (await res.json()) as ConnectionBody[];
};

const rename = (id: string, label: string, init: RequestInit = asAdmin) =>
  app.request(`/v1/org/connections/${id}`, {
    ...init,
    method: "PATCH",
    headers: {
      ...(init.headers as Record<string, string>),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ label }),
  });

const disconnect = (id: string, init: RequestInit = asAdmin) =>
  app.request(`/v1/org/connections/${id}`, { ...init, method: "DELETE" });

beforeEach(() => {
  store.users = [
    {
      id: ADMIN,
      externalAuthId: "ext-admin",
      email: "admin@x.test",
      name: null,
    },
    {
      id: MEMBER,
      externalAuthId: "ext-member",
      email: "member@x.test",
      name: null,
    },
    {
      id: OUTSIDER,
      externalAuthId: "ext-outsider",
      email: "out@x.test",
      name: null,
    },
    {
      id: OWNER,
      externalAuthId: "ext-owner",
      email: "owner@x.test",
      name: null,
    },
  ];
  store.members = [
    member(ADMIN, "admin"),
    member(MEMBER, "member"),
    member(OWNER, "owner"),
    member(OUTSIDER, "admin", OTHER_ORG),
  ];
  store.connections = [
    connection("c-org"),
    connection("c-org-notion", { provider: "notion", connectedAt: at(2) }),
    // A PROJECT-scoped row in the SAME org: visible on the project surface,
    // never on this one.
    connection("c-project", {
      scope: "project",
      projectId: PROJECT,
      organizationId: null,
    }),
    connection("c-foreign", { organizationId: OTHER_ORG }),
  ];
  store.audits = [];
  store.sessionUserId = null;
});

describe("GET /v1/org/connections", () => {
  it("returns the caller's ORG connections only — never project rows", async () => {
    expect((await listOrg()).map((c) => c.id).sort()).toEqual([
      "c-org",
      "c-org-notion",
    ]);
  });

  it("isolates orgs", async () => {
    expect((await listOrg(asOtherAdmin)).map((c) => c.id)).toEqual([
      "c-foreign",
    ]);
  });

  it("filters by ?provider= within the org scope", async () => {
    expect(
      (await listOrg(asAdmin, "?provider=notion")).map((c) => c.id),
    ).toEqual(["c-org-notion"]);
  });

  it("ignores an X-Project-Id the browser always attaches", async () => {
    // A two-key scope would OR the project's own rows back in.
    const body = await listOrg({
      headers: {
        Authorization: `Bearer ${ADMIN_KEY}`,
        "X-Project-Id": PROJECT,
      },
    });
    expect(body.map((c) => c.id).sort()).toEqual(["c-org", "c-org-notion"]);
  });
});

describe("PATCH / DELETE /v1/org/connections/:id", () => {
  it("renames an org connection and audits it against the org", async () => {
    const res = await rename("c-org", "Prod GitHub");
    expect(res.status).toBe(200);
    expect(store.connections.find((c) => c.id === "c-org")!.label).toBe(
      "Prod GitHub",
    );
    expect(store.audits).toEqual([
      expect.objectContaining({
        organizationId: ORG,
        userId: ADMIN,
        action: "update",
        service: "app-connection",
        source: "api",
        metadata: { connectionId: "c-org", scope: "organization" },
      }),
    ]);
    expect(store.audits[0]!.projectId).toBeUndefined();
  });

  it("disconnects an org connection and audits it against the org", async () => {
    const res = await disconnect("c-org");
    expect(res.status).toBe(204);
    expect(store.connections.map((c) => c.id)).not.toContain("c-org");
    expect(store.audits).toEqual([
      expect.objectContaining({
        organizationId: ORG,
        action: "disconnect",
        service: "app-connection",
        metadata: { connectionId: "c-org", scope: "organization" },
      }),
    ]);
  });

  it("404s a PROJECT-scoped connection in the same org", async () => {
    // The ownership set here carries no project arm, so a project row is
    // unreachable — and `requireProjectId` is never reached either, which is
    // what would otherwise throw for an org key with no project context.
    expect((await rename("c-project", "x")).status).toBe(404);
    expect((await disconnect("c-project")).status).toBe(404);
    expect(store.connections.map((c) => c.id)).toContain("c-project");
    expect(store.audits).toEqual([]);
  });

  it("404s another org's connection", async () => {
    expect((await disconnect("c-foreign")).status).toBe(404);
    expect(store.connections.map((c) => c.id)).toContain("c-foreign");
  });

  it("400s a blank label", async () => {
    expect((await rename("c-org", "   ")).status).toBe(400);
  });
});

describe("authorization", () => {
  it("403s every verb for a non-admin member session", async () => {
    store.sessionUserId = MEMBER;
    const asMember: RequestInit = {};
    const responses = await Promise.all([
      app.request("/v1/org/connections", asMember),
      rename("c-org", "x", asMember),
      disconnect("c-org", asMember),
    ]);
    expect(responses.map((r) => r.status)).toEqual([403, 403, 403]);
    expect(store.connections.find((c) => c.id === "c-org")!.label).toBe(
      "c-org",
    );
  });

  it("403s a PROJECT-scoped key even when its holder is an org owner", async () => {
    expect(
      (await app.request("/v1/org/connections", asProjectKey)).status,
    ).toBe(403);
    expect((await disconnect("c-org", asProjectKey)).status).toBe(403);
  });

  it("401s an unauthenticated caller", async () => {
    expect((await app.request("/v1/org/connections")).status).toBe(401);
  });
});

describe("the PROJECT surface is unchanged", () => {
  it("GET /v1/connections still inherits the org's connections alongside its own", async () => {
    const res = await app.request("/v1/connections", {
      headers: {
        Authorization: `Bearer ${PROJECT_KEY}`,
        "X-Project-Id": PROJECT,
      },
    });
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as ConnectionBody[]).map((c) => c.id).sort(),
    ).toEqual(["c-org", "c-org-notion", "c-project"]);
  });

  it("still lets a project member manage the org's rows through /v1/connections", async () => {
    // Longstanding behavior — the project surface's ownership set keeps both
    // arms, so this must not regress into a 404.
    const res = await app.request("/v1/connections/c-org", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${PROJECT_KEY}`,
        "X-Project-Id": PROJECT,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ label: "via project" }),
    });
    expect(res.status).toBe(200);
    expect(store.connections.find((c) => c.id === "c-org")!.label).toBe(
      "via project",
    );
  });

  it("still 404s another org's row on the project surface", async () => {
    const res = await app.request("/v1/connections/c-foreign", {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${PROJECT_KEY}`,
        "X-Project-Id": PROJECT,
      },
    });
    expect(res.status).toBe(404);
  });
});
