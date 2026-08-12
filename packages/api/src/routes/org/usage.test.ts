import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../../types";

// `/v1/org/usage` end-to-end through the real app, same harness shape as
// budgets.test.ts (cloned, not shared). What this router is FOR is scoping:
// `request_logs` has no organization_id, so the aggregate is fenced entirely by
// the project ids `listProjects` returns. The cases that matter are therefore
// all fencing ones — a member seeing only bound projects, a project-scoped key
// being refused org breadth, and another org seeing none of this org's traffic.
//
// NOTE ON CREDENTIALS: the non-admin cases MUST go through session auth, not an
// org API key. `oc_org_*` keys are an admin capability by construction —
// `authenticateApiKey` re-checks `role >= admin` on every request and 401s a
// demoted holder — so a member can never hold one. Session auth is how the web
// app reaches this route anyway, and it is the only path on which this router's
// member-visibility is observable at all.

const ORG = "org-1";
const OTHER_ORG = "org-2";
const ADMIN = "user-admin";
const MEMBER = "user-member";
const STRANGER = "user-stranger";
const OUTSIDER = "user-outsider";
const ADMIN_KEY = "oc_org_admin-key";
const OTHER_ORG_KEY = "oc_org_outsider-key";
const PROJECT_KEY = "oc_project-key-of-admin";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "oss";
  process.env.SECRET_ENCRYPTION_KEY = "test-secret";
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

interface ProjectRow {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  createdAt: Date;
  createdByUserId: string;
  /** User ids with a direct ProjectAccess binding. */
  boundUserIds: string[];
}

interface LogRow {
  projectId: string;
  agentId: string;
  injectionCount: number;
  createdAt: Date;
}

const store = vi.hoisted(() => ({
  members: [] as MemberRow[],
  users: [] as UserRow[],
  projects: [] as ProjectRow[],
  agents: [] as { id: string; projectId: string; name: string }[],
  logs: [] as LogRow[],
}));

vi.mock("@onecli/db", () => {
  const findMember = (organizationId: string, userId: string) =>
    store.members.find(
      (m) => m.organizationId === organizationId && m.userId === userId,
    );

  type AccessBindingFilter = { some: { OR: { userId?: string }[] } };

  /** The user ids an `accessBindings.some.OR` filter names, if present. */
  const boundUsersOf = (filter?: AccessBindingFilter) =>
    filter?.some.OR.map((o) => o.userId).filter(
      (id): id is string => id !== undefined,
    );

  interface ProjectFindManyArgs {
    where: {
      organizationId: string;
      accessBindings?: AccessBindingFilter;
    };
  }

  interface ProjectFindFirstArgs {
    where: {
      id?: string;
      organizationId?: string;
      createdByUserId?: string;
      accessBindings?: AccessBindingFilter;
    };
  }

  interface GroupByArgs {
    where: {
      projectId: { in: string[] };
      createdAt: { gte: Date };
      injectionCount?: { gt: number };
    };
  }

  const db = {
    apiKey: {
      findUnique: async ({ where }: { where: { key?: string } }) => {
        const orgKeys: Record<
          string,
          { userId: string; organizationId: string }
        > = {
          [ADMIN_KEY]: { userId: ADMIN, organizationId: ORG },
          [OTHER_ORG_KEY]: { userId: OUTSIDER, organizationId: OTHER_ORG },
        };
        const org = where.key ? orgKeys[where.key] : undefined;
        if (org) return { ...org, scope: "organization" };
        // A PROJECT-scoped key owned by an org ADMIN — it authenticates fine,
        // which is exactly why the router needs its own scope guard.
        if (where.key === PROJECT_KEY)
          return { userId: ADMIN, projectId: "proj-1" };
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
      // `activeMembershipWhere` (`status: { not: "suspended" }`) — every row in
      // this store is active, so membership alone decides.
      findFirst: async ({
        where,
      }: {
        where: { userId: string; organizationId?: string };
      }) =>
        store.members.find(
          (m) =>
            m.userId === where.userId &&
            (where.organizationId === undefined ||
              m.organizationId === where.organizationId),
        ) ?? null,
      findMany: async () => [],
    },
    project: {
      findMany: async ({ where }: ProjectFindManyArgs) => {
        const bound = boundUsersOf(where.accessBindings);
        return store.projects
          .filter(
            (p) =>
              p.organizationId === where.organizationId &&
              (bound === undefined ||
                p.boundUserIds.some((id) => bound.includes(id))),
          )
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      },
      findFirst: async ({ where }: ProjectFindFirstArgs) => {
        const bound = boundUsersOf(where.accessBindings);
        return (
          store.projects
            .filter(
              (p) =>
                (where.id === undefined || p.id === where.id) &&
                (where.organizationId === undefined ||
                  p.organizationId === where.organizationId) &&
                (where.createdByUserId === undefined ||
                  p.createdByUserId === where.createdByUserId) &&
                (bound === undefined ||
                  p.boundUserIds.some((id) => bound.includes(id))),
            )
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0] ??
          null
        );
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        store.projects.find((p) => p.id === where.id) ?? null,
    },
    projectAccess: { findFirst: async () => null },
    agent: {
      findMany: async ({
        where,
      }: {
        where: { id: { in: string[] }; projectId: { in: string[] } };
      }) =>
        store.agents
          .filter(
            (a) =>
              where.id.in.includes(a.id) &&
              where.projectId.in.includes(a.projectId),
          )
          .map((a) => ({ id: a.id, name: a.name })),
    },
    requestLog: {
      groupBy: async ({ where }: GroupByArgs) => {
        const injectedOnly = where.injectionCount !== undefined;
        const counts = new Map<string, number>();
        for (const row of store.logs) {
          if (!where.projectId.in.includes(row.projectId)) continue;
          if (row.createdAt.getTime() < where.createdAt.gte.getTime()) continue;
          if (injectedOnly && row.injectionCount === 0) continue;
          counts.set(row.agentId, (counts.get(row.agentId) ?? 0) + 1);
        }
        return [...counts].map(([agentId, n]) => ({
          agentId,
          _count: { _all: n },
        }));
      },
    },
    $transaction: async (promises: Promise<unknown>[]) => Promise.all(promises),
    auditLog: { create: async () => ({}) },
  };

  return { Prisma: { JsonNull: null }, db };
});

import { createApiApp } from "../../app";
import { registerOssOrgRoutes } from "./index";
import { ossRoleResolver } from "../../services/org-role-resolver";

// Signed-in browser sessions: the request names its user through a test-only
// `x-test-session` header, which the provider maps to that user's external auth
// id (what a real provider would read out of a cookie).
const sessionProvider = {
  getSession: async (request: Request) => {
    const userId = request.headers.get("x-test-session");
    const user = userId ? store.users.find((u) => u.id === userId) : undefined;
    return user ? { id: user.externalAuthId, email: user.email } : null;
  },
};

const app: Hono<ApiEnv> = createApiApp(sessionProvider, {
  eeRoutes: registerOssOrgRoutes,
  roleResolver: ossRoleResolver,
});

const at = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m));
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

const member = (
  userId: string,
  role: string,
  organizationId: string,
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

const log = (projectId: string, agentId: string, injectionCount: number) => ({
  projectId,
  agentId,
  injectionCount,
  createdAt: minutesAgo(5),
});

beforeEach(() => {
  store.users = [ADMIN, MEMBER, STRANGER, OUTSIDER].map((id) => ({
    id,
    externalAuthId: `ext-${id}`,
    email: `${id}@x.test`,
    name: null,
  }));
  store.members = [
    member(ADMIN, "admin", ORG),
    member(MEMBER, "member", ORG),
    member(STRANGER, "member", ORG),
    member(OUTSIDER, "admin", OTHER_ORG),
  ];
  store.projects = [
    {
      id: "proj-1",
      organizationId: ORG,
      name: "One",
      slug: "one",
      createdAt: at(1),
      createdByUserId: ADMIN,
      boundUserIds: [ADMIN, MEMBER],
    },
    {
      id: "proj-2",
      organizationId: ORG,
      name: "Two",
      slug: "two",
      createdAt: at(2),
      createdByUserId: ADMIN,
      boundUserIds: [ADMIN],
    },
    {
      id: "proj-other",
      organizationId: OTHER_ORG,
      name: "Other",
      slug: "other",
      createdAt: at(3),
      createdByUserId: OUTSIDER,
      boundUserIds: [OUTSIDER],
    },
  ];
  store.agents = [
    { id: "agent-a", projectId: "proj-1", name: "Helm" },
    { id: "agent-b", projectId: "proj-2", name: "Bridge" },
    { id: "agent-x", projectId: "proj-other", name: "Foreign" },
  ];
  store.logs = [
    log("proj-1", "agent-a", 1),
    log("proj-1", "agent-a", 0),
    log("proj-2", "agent-b", 1),
    log("proj-2", "agent-b", 1),
    log("proj-2", "agent-b", 0),
    log("proj-other", "agent-x", 1),
  ];
});

const bearer = (key: string): RequestInit => ({
  headers: { Authorization: `Bearer ${key}` },
});

/** A signed-in browser with `organizationId` selected in the org switcher. */
const session = (userId: string, organizationId = ORG): RequestInit => ({
  headers: { "x-test-session": userId, "x-organization-id": organizationId },
});

interface UsageBody {
  periodStart: string;
  periodEnd: string;
  requests: number;
  integrationCalls: number;
  agents: {
    agentId: string;
    agentName: string | null;
    requests: number;
    integrationCalls: number;
  }[];
}

const get = (init: RequestInit) => app.request("/v1/org/usage", init);

const usage = async (init: RequestInit): Promise<UsageBody> => {
  const res = await get(init);
  expect(res.status).toBe(200);
  return (await res.json()) as UsageBody;
};

describe("GET /v1/org/usage — project fencing", () => {
  it("an admin sees every project in the org", async () => {
    const body = await usage(bearer(ADMIN_KEY));

    expect(body.requests).toBe(5);
    expect(body.integrationCalls).toBe(3);
    expect(body.agents.map((a) => a.agentName)).toEqual(["Bridge", "Helm"]);
  });

  it("a member sees only the projects they are bound to", async () => {
    const body = await usage(session(MEMBER));

    // proj-1 only: agent-a's two rows, one of them injected. proj-2's traffic
    // is invisible — this is the whole point of the router.
    expect(body.requests).toBe(2);
    expect(body.integrationCalls).toBe(1);
    expect(body.agents).toEqual([
      {
        agentId: "agent-a",
        agentName: "Helm",
        requests: 2,
        integrationCalls: 1,
      },
    ]);
  });

  it("a member with no bindings gets a zeroed summary, not a 403", async () => {
    const res = await get(session(STRANGER));
    expect(res.status).toBe(200);

    const body = (await res.json()) as UsageBody;
    expect(body.requests).toBe(0);
    expect(body.integrationCalls).toBe(0);
    expect(body.agents).toEqual([]);
    // The bounds are real even with nothing to report, so the UI's date range
    // still describes the window that was measured.
    expect(Date.parse(body.periodEnd) - Date.parse(body.periodStart)).toBe(
      30 * 24 * 60 * 60 * 1000,
    );
  });

  it("another organization sees none of this org's traffic", async () => {
    const body = await usage(bearer(OTHER_ORG_KEY));

    // Their own project's single row, and nothing from ORG.
    expect(body.requests).toBe(1);
    expect(body.agents.map((a) => a.agentId)).toEqual(["agent-x"]);
  });

  it("a member of another org sees nothing of this one, even when they name it", async () => {
    // `resolveOrganizationId` only honours an org the caller is an active
    // member of, so the header cannot be used to borrow another org's scope.
    const res = await get(session(OUTSIDER, ORG));

    expect(res.status).toBe(401);
  });
});

describe("GET /v1/org/usage — credential scope", () => {
  it("refuses a project-scoped key even when its user is an org admin", async () => {
    const res = await get(bearer(PROJECT_KEY));

    expect(res.status).toBe(403);
  });

  it("refuses an unknown key", async () => {
    const res = await get(bearer("oc_org_nope"));

    expect(res.status).toBe(401);
  });
});

describe("GET /v1/org/usage — response shape", () => {
  it("totals equal the sum of the agent rows", async () => {
    const body = await usage(bearer(ADMIN_KEY));

    expect(body.requests).toBe(body.agents.reduce((n, a) => n + a.requests, 0));
    expect(body.integrationCalls).toBe(
      body.agents.reduce((n, a) => n + a.integrationCalls, 0),
    );
  });

  it("never reports more integration calls than requests", async () => {
    const body = await usage(bearer(ADMIN_KEY));

    expect(body.integrationCalls).toBeLessThanOrEqual(body.requests);
    for (const row of body.agents) {
      expect(row.integrationCalls).toBeLessThanOrEqual(row.requests);
    }
  });
});
