import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../../types";

// `/v1/org/members` end-to-end through the real app: the OSS org routes mounted
// on the `eeRoutes` seam, the OSS role resolver wired as the RoleResolver, and
// `CAPS.rbac` on. Admin callers arrive with an org API key (whose key path
// re-checks admin through the resolver); the non-admin cases use a session,
// since a non-admin's org key fails key authentication outright.

const ORG = "org-1";
const OTHER_ORG = "org-2";
const OWNER = "user-owner";
const ADMIN = "user-admin";
const MEMBER = "user-member";
const ADMIN_KEY = "oc_org_admin-key";
const PROJECT_KEY = "oc_project-key-of-owner";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "oss";
  process.env.SECRET_ENCRYPTION_KEY = "test-secret";
  process.env.OAUTH_STATE_SECRET = "test-secret";
});

interface MemberRow {
  organizationId: string;
  userId: string;
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

interface AuditRow {
  organizationId?: string;
  userId: string;
  action: string;
  service: string;
  source: string;
  metadata: unknown;
}

const store = vi.hoisted(() => ({
  members: [] as MemberRow[],
  users: [] as UserRow[],
  audits: [] as AuditRow[],
  /** Which user the session provider resolves to (null = no session). */
  sessionUserId: null as string | null,
}));

vi.mock("@onecli/db", () => {
  // The subset of the Prisma `where` shapes these routes actually build.
  interface MemberWhere {
    organizationId?: string;
    userId?: string;
    role?: string;
    status?: string | { not?: string };
    user?: {
      OR: { email?: { contains: string }; name?: { contains: string } }[];
    };
    /** The keyset predicate — the service nests it under AND, never top-level. */
    AND?: {
      OR: { createdAt?: Date | { gt?: Date }; userId?: { gt: string } }[];
    }[];
  }
  interface MemberSelect {
    userId?: boolean;
    role?: boolean;
    status?: boolean;
    ssoExempt?: boolean;
  }
  interface MemberKey {
    organizationId_userId: { organizationId: string; userId: string };
  }

  const matchesStatus = (
    row: MemberRow,
    filter: MemberWhere["status"],
  ): boolean => {
    if (filter === undefined) return true;
    if (typeof filter === "string") return row.status === filter;
    return filter.not === undefined ? true : row.status !== filter.not;
  };

  const matchesQuery = (row: MemberRow, filter: MemberWhere["user"]) => {
    if (!filter) return true;
    const user = store.users.find((u) => u.id === row.userId);
    if (!user) return false;
    return filter.OR.some((clause) => {
      const needle = clause.email?.contains ?? clause.name?.contains;
      if (needle === undefined) return false;
      const haystack = clause.email ? user.email : (user.name ?? "");
      return haystack.toLowerCase().includes(needle.toLowerCase());
    });
  };

  const matchesCursor = (row: MemberRow, filter: MemberWhere["AND"]) => {
    if (!filter) return true;
    return filter.every((conjunct) =>
      conjunct.OR.some((clause) => {
        if (clause.createdAt instanceof Date) {
          return (
            row.createdAt.getTime() === clause.createdAt.getTime() &&
            clause.userId !== undefined &&
            row.userId > clause.userId.gt
          );
        }
        const gt = clause.createdAt?.gt;
        return gt !== undefined && row.createdAt.getTime() > gt.getTime();
      }),
    );
  };

  const filterMembers = (where: MemberWhere) =>
    store.members.filter(
      (row) =>
        (where.organizationId === undefined ||
          row.organizationId === where.organizationId) &&
        (where.userId === undefined || row.userId === where.userId) &&
        (where.role === undefined || row.role === where.role) &&
        matchesStatus(row, where.status) &&
        matchesQuery(row, where.user) &&
        matchesCursor(row, where.AND),
    );

  const findMember = (organizationId: string, userId: string) =>
    store.members.find(
      (row) => row.organizationId === organizationId && row.userId === userId,
    );

  // Mirror Prisma's `select` so a route can't accidentally leak a column the
  // service didn't ask for (the mock would otherwise hand back whole rows).
  const project = (row: MemberRow, select?: MemberSelect) => {
    if (!select) return row;
    const picked: Record<string, unknown> = {};
    if (select.userId) picked.userId = row.userId;
    if (select.role) picked.role = row.role;
    if (select.status) picked.status = row.status;
    if (select.ssoExempt) picked.ssoExempt = row.ssoExempt;
    return picked;
  };

  return {
    Prisma: { JsonNull: null },
    db: {
      apiKey: {
        findUnique: async ({ where }: { where: { key?: string } }) => {
          if (where.key === "oc_org_admin-key")
            return {
              userId: "user-admin",
              organizationId: "org-1",
              scope: "organization",
            };
          // A PROJECT-scoped key owned by the org's OWNER: it authenticates
          // fine, which is exactly why the router needs its own scope guard.
          if (where.key === "oc_project-key-of-owner")
            return { userId: "user-owner", projectId: "proj-1" };
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
          select,
        }: {
          where: MemberKey;
          select?: MemberSelect;
        }) => {
          const { organizationId, userId } = where.organizationId_userId;
          const row = findMember(organizationId, userId);
          return row ? project(row, select) : null;
        },
        findFirst: async ({ where }: { where: MemberWhere }) =>
          filterMembers(where)[0] ?? null,
        findMany: async ({
          where,
          take,
        }: {
          where: MemberWhere;
          take?: number;
        }) => {
          const rows = filterMembers(where)
            .slice()
            .sort(
              (a, b) =>
                a.createdAt.getTime() - b.createdAt.getTime() ||
                a.userId.localeCompare(b.userId),
            )
            .map((row) => ({
              ...row,
              user: store.users.find((u) => u.id === row.userId) ?? {
                email: "",
                name: null,
              },
            }));
          return take === undefined ? rows : rows.slice(0, take);
        },
        count: async ({ where }: { where: MemberWhere }) =>
          filterMembers(where).length,
        update: async ({
          where,
          data,
          select,
        }: {
          where: MemberKey;
          data: { status?: string; role?: string; suspendedAt?: Date | null };
          select?: MemberSelect;
        }) => {
          const { organizationId, userId } = where.organizationId_userId;
          const row = findMember(organizationId, userId);
          if (!row) throw new Error("no such member");
          if (data.status !== undefined) row.status = data.status;
          if (data.role !== undefined) row.role = data.role;
          if (data.suspendedAt !== undefined)
            row.suspendedAt = data.suspendedAt;
          return project(row, select);
        },
      },
      project: {
        findFirst: async () => ({ id: "proj-1", organizationId: "org-1" }),
        findUnique: async () => ({ id: "proj-1", organizationId: "org-1" }),
      },
      projectAccess: { findFirst: async () => null },
      auditLog: {
        create: async ({ data }: { data: AuditRow }) => {
          store.audits.push(data);
          return data;
        },
      },
    },
  };
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
  createdAt: Date,
  organizationId = ORG,
): MemberRow => ({
  organizationId,
  userId,
  role,
  status: "active",
  ssoExempt: false,
  suspendedAt: null,
  createdAt,
});

beforeEach(() => {
  store.users = [
    {
      id: OWNER,
      externalAuthId: "ext-owner",
      email: "owner@example.com",
      name: "Olive Owner",
    },
    {
      id: ADMIN,
      externalAuthId: "ext-admin",
      email: "admin@example.com",
      name: "Adam Admin",
    },
    {
      id: MEMBER,
      externalAuthId: "ext-member",
      email: "member@elsewhere.test",
      name: null,
    },
  ];
  store.members = [
    member(OWNER, "owner", at(0)),
    member(ADMIN, "admin", at(1)),
    member(MEMBER, "member", at(2)),
    // A member of a DIFFERENT org — never visible through this org's routes.
    member("user-outsider", "admin", at(3), OTHER_ORG),
  ];
  store.audits = [];
  store.sessionUserId = null;
});

const rowFor = (userId: string) =>
  store.members.find((m) => m.userId === userId);

const asAdmin = { headers: { Authorization: `Bearer ${ADMIN_KEY}` } };
const asProjectKey = {
  headers: { Authorization: `Bearer ${PROJECT_KEY}` },
};

const patch = (userId: string, body: unknown, init: RequestInit = asAdmin) =>
  app.request(`/v1/org/members/${userId}`, {
    ...init,
    method: "PATCH",
    body: JSON.stringify(body),
  });

interface MemberListBody {
  data: {
    userId: string;
    email: string;
    name: string | null;
    role: string;
    status: string;
    ssoExempt: boolean;
    joinedAt: string;
  }[];
  nextCursor: string | null;
}

const list = async (query = ""): Promise<MemberListBody> => {
  const res = await app.request(`/v1/org/members${query}`, asAdmin);
  expect(res.status).toBe(200);
  return (await res.json()) as MemberListBody;
};

describe("GET /v1/org/members", () => {
  it("returns the org's members in the page envelope", async () => {
    const body = await list();
    expect(body.nextCursor).toBeNull();
    expect(body.data.map((row) => row.userId)).toEqual([OWNER, ADMIN, MEMBER]);
    expect(body.data[0]).toEqual({
      userId: OWNER,
      email: "owner@example.com",
      name: "Olive Owner",
      role: "owner",
      status: "active",
      ssoExempt: false,
      joinedAt: at(0).toISOString(),
    });
  });

  it("never leaks members of another organization", async () => {
    const body = await list();
    expect(body.data.some((row) => row.userId === "user-outsider")).toBe(false);
  });

  it("filters by status", async () => {
    const row = rowFor(MEMBER);
    if (row) row.status = "suspended";
    const body = await list("?status=suspended");
    expect(body.data.map((r) => r.userId)).toEqual([MEMBER]);
  });

  it("filters by free-text q over email and name", async () => {
    expect((await list("?q=ELSEWHERE")).data.map((r) => r.userId)).toEqual([
      MEMBER,
    ]);
    expect((await list("?q=olive")).data.map((r) => r.userId)).toEqual([OWNER]);
  });

  it("pages with an opaque cursor and ends with nextCursor null", async () => {
    const first = await list("?limit=2");
    expect(first.data.map((r) => r.userId)).toEqual([OWNER, ADMIN]);
    expect(first.nextCursor).toBeTruthy();

    const second = await list(
      `?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
    );
    expect(second.data.map((r) => r.userId)).toEqual([MEMBER]);
    expect(second.nextCursor).toBeNull();
  });

  it("treats a malformed cursor as the first page instead of failing", async () => {
    const body = await list("?cursor=not-a-real-cursor");
    expect(body.data).toHaveLength(3);
  });

  it("walks every page exactly once when createdAt ties", async () => {
    // Same millisecond for all three: only the userId half of the cursor can
    // separate them, so a one-at-a-time walk is the tiebreak's real test.
    for (const row of store.members) row.createdAt = at(7);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const body: MemberListBody = await list(
        `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      seen.push(...body.data.map((r) => r.userId));
      cursor = body.nextCursor;
      if (!cursor) break;
    }

    expect(cursor).toBeNull();
    expect(seen.slice().sort()).toEqual([ADMIN, MEMBER, OWNER].slice().sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("rejects an out-of-range limit with 422", async () => {
    const res = await app.request("/v1/org/members?limit=5000", asAdmin);
    expect(res.status).toBe(422);
  });

  it("rejects limit=0 with 422", async () => {
    const res = await app.request("/v1/org/members?limit=0", asAdmin);
    expect(res.status).toBe(422);
  });

  it("rejects a non-numeric limit with 422", async () => {
    const res = await app.request("/v1/org/members?limit=abc", asAdmin);
    expect(res.status).toBe(422);
  });

  it("403s a project-scoped key even when its user is an org owner", async () => {
    // A leaked agent/project key must never become an org-management
    // credential: `role: "admin"` alone would pass here.
    const res = await app.request("/v1/org/members", asProjectKey);
    expect(res.status).toBe(403);
  });

  it("403s a non-admin member (deterministic, not a 401)", async () => {
    store.sessionUserId = MEMBER;
    const res = await app.request("/v1/org/members");
    expect(res.status).toBe(403);
  });

  it("200s an owner (owner outranks admin)", async () => {
    store.sessionUserId = OWNER;
    const res = await app.request("/v1/org/members");
    expect(res.status).toBe(200);
  });

  it("rejects a suspended admin's org key (suspended reads as no role)", async () => {
    const row = rowFor(ADMIN);
    if (row) row.status = "suspended";
    const res = await app.request("/v1/org/members", asAdmin);
    expect(res.status).toBe(401);
  });

  it("401s an unauthenticated caller", async () => {
    const res = await app.request("/v1/org/members");
    expect(res.status).toBe(401);
  });
});

describe("PATCH /v1/org/members/:userId — status", () => {
  it("suspends a member and stamps suspendedAt", async () => {
    const res = await patch(MEMBER, { status: "suspended" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: MEMBER,
      status: "suspended",
      ssoExempt: false,
    });
    expect(rowFor(MEMBER)?.status).toBe("suspended");
    expect(rowFor(MEMBER)?.suspendedAt).toBeInstanceOf(Date);
  });

  it("reinstates a suspended member and clears suspendedAt", async () => {
    const row = rowFor(MEMBER);
    if (row) {
      row.status = "suspended";
      row.suspendedAt = at(9);
    }
    const res = await patch(MEMBER, { status: "active" });
    expect(res.status).toBe(200);
    expect(rowFor(MEMBER)?.status).toBe("active");
    expect(rowFor(MEMBER)?.suspendedAt).toBeNull();
  });

  it("writes an audit row for the change", async () => {
    await patch(MEMBER, { status: "suspended" });
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({
      organizationId: ORG,
      userId: ADMIN,
      action: "update",
      service: "member",
      source: "api",
      metadata: { targetUserId: MEMBER, status: "suspended" },
    });
  });

  it("404s an unknown target and audits nothing", async () => {
    const res = await patch("user-nobody", { status: "suspended" });
    expect(res.status).toBe(404);
    expect(store.audits).toHaveLength(0);
  });

  it("404s a member of another organization", async () => {
    const res = await patch("user-outsider", { status: "suspended" });
    expect(res.status).toBe(404);
    expect(rowFor("user-outsider")?.status).toBe("active");
  });

  it("400s a self-suspend", async () => {
    const res = await patch(ADMIN, { status: "suspended" });
    expect(res.status).toBe(400);
    expect(rowFor(ADMIN)?.status).toBe("active");
  });

  it("403s suspending an owner while another active owner remains", async () => {
    store.members.push(member("user-owner-2", "owner", at(4)));
    const res = await patch(OWNER, { status: "suspended" });
    expect(res.status).toBe(403);
    expect(rowFor(OWNER)?.status).toBe("active");
  });

  it("409s suspending the last active owner", async () => {
    const res = await patch(OWNER, { status: "suspended" });
    expect(res.status).toBe(409);
    expect(rowFor(OWNER)?.status).toBe("active");
  });

  it("REINSTATES a suspended owner — the owner guard is suspend-only", async () => {
    // The org's only owner is already suspended: refusing the repair would
    // cement exactly the unrecoverable state the owner rules exist to prevent.
    const owner = rowFor(OWNER);
    if (owner) {
      owner.status = "suspended";
      owner.suspendedAt = at(9);
    }
    const res = await patch(OWNER, { status: "active" });
    expect(res.status).toBe(200);
    expect(rowFor(OWNER)?.status).toBe("active");
    expect(rowFor(OWNER)?.suspendedAt).toBeNull();
  });

  it("400s an OWNER suspending themselves (not just admins)", async () => {
    store.sessionUserId = OWNER;
    const res = await patch(OWNER, { status: "suspended" }, {});
    expect(res.status).toBe(400);
    expect(rowFor(OWNER)?.status).toBe("active");
  });

  it("400s an OWNER changing their own role", async () => {
    store.sessionUserId = OWNER;
    const res = await patch(OWNER, { role: "admin" }, {});
    expect(res.status).toBe(400);
    expect(rowFor(OWNER)?.role).toBe("owner");
  });

  it("403s a project-scoped key attempting a write", async () => {
    const res = await patch(MEMBER, { status: "suspended" }, asProjectKey);
    expect(res.status).toBe(403);
    expect(rowFor(MEMBER)?.status).toBe("active");
    expect(store.audits).toHaveLength(0);
  });
});

describe("PATCH /v1/org/members/:userId — role", () => {
  it("promotes a member to admin", async () => {
    const res = await patch(MEMBER, { role: "admin" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: MEMBER, role: "admin" });
    expect(rowFor(MEMBER)?.role).toBe("admin");
    expect(store.audits[0]).toMatchObject({
      metadata: { targetUserId: MEMBER, role: "admin" },
    });
  });

  it("400s changing your own role", async () => {
    const res = await patch(ADMIN, { role: "member" });
    expect(res.status).toBe(400);
    expect(rowFor(ADMIN)?.role).toBe("admin");
  });

  it("403s changing an owner's role", async () => {
    const res = await patch(OWNER, { role: "admin" });
    expect(res.status).toBe(403);
    expect(rowFor(OWNER)?.role).toBe("owner");
  });

  it("422s an unassignable role", async () => {
    const res = await patch(MEMBER, { role: "owner" });
    expect(res.status).toBe(422);
    expect(rowFor(MEMBER)?.role).toBe("member");
  });
});

describe("PATCH /v1/org/members/:userId — body validation", () => {
  it("422s a body carrying both status and role", async () => {
    const res = await patch(MEMBER, { status: "suspended", role: "admin" });
    expect(res.status).toBe(422);
    expect(store.audits).toHaveLength(0);
  });

  it("422s an empty body", async () => {
    const res = await patch(MEMBER, {});
    expect(res.status).toBe(422);
  });

  it("422s a missing/unparseable body", async () => {
    const res = await app.request(`/v1/org/members/${MEMBER}`, {
      ...asAdmin,
      method: "PATCH",
    });
    expect(res.status).toBe(422);
  });

  it("422s an unknown status value", async () => {
    const res = await patch(MEMBER, { status: "deleted" });
    expect(res.status).toBe(422);
  });

  it("403s a non-admin attempting a write, before the service runs", async () => {
    store.sessionUserId = MEMBER;
    const res = await patch(OWNER, { status: "suspended" }, {});
    expect(res.status).toBe(403);
    expect(rowFor(OWNER)?.status).toBe("active");
    expect(store.audits).toHaveLength(0);
  });
});
