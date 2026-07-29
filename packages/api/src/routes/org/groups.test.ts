import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../../types";

// `/v1/org/groups` end-to-end through the real app: the OSS org routes
// mounted on the `eeRoutes` seam, the OSS role resolver wired as the
// RoleResolver, and `CAPS.rbac` on. Admin callers arrive with an org API key
// (whose key path re-checks admin through the resolver); the non-admin cases
// use a session, since a non-admin's org key fails key authentication
// outright. (Same harness as invitations.test.ts / members.test.ts — cloned,
// not shared.)
//
// Reconciliation Stage C ships USER GROUPS ONLY. Role automation
// (group→org-role mappings) and policy-rule orphan neutralization are separate
// later stages and are NOT exercised here — the OSS grants engine already
// treats a rule identity orphaned by an FK cascade as inert, so a group delete
// needs no explicit neutralization pass.

const ORG = "org-1";
const OTHER_ORG = "org-2";
const OWNER = "user-owner";
const ADMIN = "user-admin";
const MEMBER = "user-member";
const OUTSIDER = "user-outsider";
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

interface GroupRow {
  id: string;
  organizationId: string;
  name: string;
  source: string;
  externalId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface GroupMemberRow {
  groupId: string;
  userId: string;
  createdByUserId: string | null;
  createdAt: Date;
}

interface ProjectAccessRow {
  id: string;
  projectId: string;
  groupId: string;
}

interface AuditRow {
  organizationId?: string;
  userId: string;
  action: string;
  service: string;
  source: string;
  metadata: Record<string, unknown>;
}

const store = vi.hoisted(() => ({
  members: [] as MemberRow[],
  users: [] as UserRow[],
  groups: [] as GroupRow[],
  groupMembers: [] as GroupMemberRow[],
  projectAccess: [] as ProjectAccessRow[],
  audits: [] as AuditRow[],
  seq: 0,
  txCount: 0,
  /** Simulate a create-create race: the name pre-check misses, create P2002s. */
  race: false,
  /** Which user the session provider resolves to (null = no session). */
  sessionUserId: null as string | null,
}));

vi.mock("@onecli/db", () => {
  class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }

  // The subset of the Prisma `where` shapes these routes actually build.
  interface KeysetClause {
    createdAt?: Date | { gt?: Date };
    id?: { gt: string };
    userId?: { gt: string };
  }
  interface GroupWhere {
    id?: string | { not: string };
    organizationId?: string;
    source?: string;
    name?: string | { contains: string };
    /** The keyset predicate — the service nests it under AND, never top-level. */
    AND?: { OR: KeysetClause[] }[];
  }
  interface GroupSelect {
    id?: boolean;
    name?: boolean;
    source?: boolean;
    externalId?: boolean;
    createdAt?: boolean;
    updatedAt?: boolean;
    _count?: { select: { members?: boolean; projectAccess?: boolean } };
  }
  interface GroupMemberWhere {
    groupId?: string | { in: string[] };
    userId?: string | { in: string[] };
    user?: {
      OR: { email?: { contains: string }; name?: { contains: string } }[];
    };
    AND?: { OR: KeysetClause[] }[];
  }
  interface OrgMemberWhere {
    organizationId?: string;
    userId?: string | { in: string[] };
    role?: string | { not?: string };
    status?: string | { not?: string };
  }

  const matchesKeyset = (
    row: { createdAt: Date; id?: string; userId?: string },
    filter: { OR: KeysetClause[] }[] | undefined,
  ) => {
    if (!filter) return true;
    return filter.every((conjunct) =>
      conjunct.OR.some((clause) => {
        if (clause.createdAt instanceof Date) {
          if (row.createdAt.getTime() !== clause.createdAt.getTime())
            return false;
          if (clause.id !== undefined && row.id !== undefined)
            return row.id > clause.id.gt;
          if (clause.userId !== undefined && row.userId !== undefined)
            return row.userId > clause.userId.gt;
          return false;
        }
        const gt = clause.createdAt?.gt;
        return gt !== undefined && row.createdAt.getTime() > gt.getTime();
      }),
    );
  };

  const filterGroups = (where: GroupWhere) =>
    store.groups.filter((row) => {
      if (typeof where.id === "string" && row.id !== where.id) return false;
      if (
        typeof where.id === "object" &&
        where.id !== null &&
        row.id === where.id.not
      )
        return false;
      if (
        where.organizationId !== undefined &&
        row.organizationId !== where.organizationId
      )
        return false;
      if (where.source !== undefined && row.source !== where.source)
        return false;
      if (typeof where.name === "string" && row.name !== where.name)
        return false;
      if (
        typeof where.name === "object" &&
        where.name !== null &&
        !row.name.toLowerCase().includes(where.name.contains.toLowerCase())
      )
        return false;
      return matchesKeyset(row, where.AND);
    });

  // Mirror Prisma's `select` (incl. `_count`) so a route can't accidentally
  // leak a column the service didn't ask for.
  const pickGroup = (row: GroupRow, select?: GroupSelect) => {
    if (!select) return { ...row };
    const picked: Record<string, unknown> = {};
    for (const key of [
      "id",
      "name",
      "source",
      "externalId",
      "createdAt",
      "updatedAt",
    ] as const) {
      if (select[key]) picked[key] = row[key];
    }
    if (select._count) {
      const count: Record<string, number> = {};
      if (select._count.select.members) {
        count.members = store.groupMembers.filter(
          (m) => m.groupId === row.id,
        ).length;
      }
      if (select._count.select.projectAccess) {
        count.projectAccess = store.projectAccess.filter(
          (pa) => pa.groupId === row.id,
        ).length;
      }
      picked._count = count;
    }
    return picked;
  };

  const filterGroupMembers = (where: GroupMemberWhere) =>
    store.groupMembers.filter((row) => {
      if (typeof where.groupId === "string" && row.groupId !== where.groupId)
        return false;
      if (
        typeof where.groupId === "object" &&
        where.groupId !== null &&
        !where.groupId.in.includes(row.groupId)
      )
        return false;
      if (typeof where.userId === "string" && row.userId !== where.userId)
        return false;
      if (
        typeof where.userId === "object" &&
        where.userId !== null &&
        !where.userId.in.includes(row.userId)
      )
        return false;
      if (where.user) {
        const user = store.users.find((u) => u.id === row.userId);
        if (!user) return false;
        const hit = where.user.OR.some((clause) => {
          if (clause.email)
            return user.email
              .toLowerCase()
              .includes(clause.email.contains.toLowerCase());
          if (clause.name)
            return (user.name ?? "")
              .toLowerCase()
              .includes(clause.name.contains.toLowerCase());
          return false;
        });
        if (!hit) return false;
      }
      return matchesKeyset(row, where.AND);
    });

  const findMember = (organizationId: string, userId: string) =>
    store.members.find(
      (row) => row.organizationId === organizationId && row.userId === userId,
    );

  const filterOrgMembers = (where: OrgMemberWhere) =>
    store.members.filter((row) => {
      if (
        where.organizationId !== undefined &&
        row.organizationId !== where.organizationId
      )
        return false;
      if (typeof where.userId === "string" && row.userId !== where.userId)
        return false;
      if (
        typeof where.userId === "object" &&
        where.userId !== null &&
        !where.userId.in.includes(row.userId)
      )
        return false;
      if (where.status !== undefined) {
        const ok =
          typeof where.status === "string"
            ? row.status === where.status
            : where.status.not === undefined || row.status !== where.status.not;
        if (!ok) return false;
      }
      if (where.role !== undefined) {
        const ok =
          typeof where.role === "string"
            ? row.role === where.role
            : where.role.not === undefined || row.role !== where.role.not;
        if (!ok) return false;
      }
      return true;
    });

  const dbGroup = {
    findFirst: async ({
      where,
      select,
    }: {
      where: GroupWhere;
      select?: GroupSelect;
    }) => {
      // Race simulation: the create pre-check (a name-keyed findFirst)
      // misses, so the create itself must surface the P2002.
      if (store.race && where.name !== undefined) return null;
      const row = filterGroups(where)[0];
      return row ? pickGroup(row, select) : null;
    },
    findMany: async ({
      where,
      select,
      take,
    }: {
      where: GroupWhere;
      select?: GroupSelect;
      take?: number;
    }) => {
      const rows = filterGroups(where)
        .slice()
        .sort(
          (a, b) =>
            a.createdAt.getTime() - b.createdAt.getTime() ||
            a.id.localeCompare(b.id),
        );
      const limited = take === undefined ? rows : rows.slice(0, take);
      return limited.map((row) => pickGroup(row, select));
    },
    create: async ({
      data,
      select,
    }: {
      data: {
        organizationId: string;
        name: string;
        source: string;
        externalId?: string | null;
      };
      select?: GroupSelect;
    }) => {
      const dupe = store.groups.some(
        (g) => g.organizationId === data.organizationId && g.name === data.name,
      );
      if (dupe) {
        throw new PrismaClientKnownRequestError(
          "Unique constraint failed",
          "P2002",
        );
      }
      const row: GroupRow = {
        id: `g-${++store.seq}`,
        organizationId: data.organizationId,
        name: data.name,
        source: data.source,
        externalId: data.externalId ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      store.groups.push(row);
      return pickGroup(row, select);
    },
    // Org-scoped conditional write (the rename path): unique violations
    // surface as P2002, a filter miss as count 0.
    updateMany: async ({
      where,
      data,
    }: {
      where: GroupWhere;
      data: { name: string };
    }) => {
      const rows = filterGroups(where);
      for (const row of rows) {
        const dupe = store.groups.some(
          (g) =>
            g.organizationId === row.organizationId &&
            g.name === data.name &&
            g.id !== row.id,
        );
        if (dupe) {
          throw new PrismaClientKnownRequestError(
            "Unique constraint failed",
            "P2002",
          );
        }
        row.name = data.name;
        row.updatedAt = new Date();
      }
      return { count: rows.length };
    },
    // Delete applies the DB cascades the shipped migration declares:
    // GroupMember and ProjectAccess group bindings go with the row (as do
    // GroupRoleMapping and PolicyRuleIdentity in stages that populate them).
    deleteMany: async ({ where }: { where: GroupWhere }) => {
      const rows = filterGroups(where);
      for (const row of rows) {
        store.groupMembers = store.groupMembers.filter(
          (m) => m.groupId !== row.id,
        );
        store.projectAccess = store.projectAccess.filter(
          (pa) => pa.groupId !== row.id,
        );
      }
      const ids = new Set(rows.map((r) => r.id));
      store.groups = store.groups.filter((g) => !ids.has(g.id));
      return { count: rows.length };
    },
  };

  return {
    Prisma: { JsonNull: null, PrismaClientKnownRequestError },
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
          where: { id?: string; externalAuthId?: string; email?: string };
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
                  u.externalAuthId === where.externalAuthId) ||
                (where.email !== undefined && u.email === where.email),
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
        // The session auth path resolves membership through these — a stub
        // returning null would read every session caller as org-less (401).
        findFirst: async ({
          where,
        }: {
          where: {
            organizationId?: string;
            userId?: string;
            status?: string | { not?: string };
          };
        }) =>
          store.members.find(
            (row) =>
              (where.organizationId === undefined ||
                row.organizationId === where.organizationId) &&
              (where.userId === undefined || row.userId === where.userId) &&
              (where.status === undefined ||
                (typeof where.status === "string"
                  ? row.status === where.status
                  : where.status.not === undefined ||
                    row.status !== where.status.not)),
          ) ?? null,
        // THE membership-validation query: { organizationId, userId: { in } }.
        findMany: async ({
          where,
          select,
        }: {
          where: OrgMemberWhere;
          select?: { userId?: boolean; role?: boolean };
        }) =>
          filterOrgMembers(where).map((row) => {
            if (!select) return { ...row };
            const picked: Record<string, unknown> = {};
            if (select.userId) picked.userId = row.userId;
            if (select.role) picked.role = row.role;
            return picked;
          }),
        count: async () => 0,
      },
      group: dbGroup,
      groupMember: {
        findUnique: async ({
          where,
        }: {
          where: { groupId_userId: { groupId: string; userId: string } };
        }) => {
          const { groupId, userId } = where.groupId_userId;
          const row = store.groupMembers.find(
            (m) => m.groupId === groupId && m.userId === userId,
          );
          return row ? { userId: row.userId } : null;
        },
        findMany: async ({
          where,
          select,
          take,
        }: {
          where: GroupMemberWhere;
          select?: {
            groupId?: boolean;
            userId?: boolean;
            createdAt?: boolean;
            user?: { select: { email?: boolean; name?: boolean } };
          };
          take?: number;
        }) => {
          const rows = filterGroupMembers(where)
            .slice()
            .sort(
              (a, b) =>
                a.createdAt.getTime() - b.createdAt.getTime() ||
                a.userId.localeCompare(b.userId),
            );
          const limited = take === undefined ? rows : rows.slice(0, take);
          return limited.map((row) => {
            if (!select) return { ...row };
            const picked: Record<string, unknown> = {};
            if (select.groupId) picked.groupId = row.groupId;
            if (select.userId) picked.userId = row.userId;
            if (select.createdAt) picked.createdAt = row.createdAt;
            if (select.user) {
              const user = store.users.find((u) => u.id === row.userId);
              picked.user = {
                email: user?.email ?? "missing@example.com",
                name: user?.name ?? null,
              };
            }
            return picked;
          });
        },
        upsert: async ({
          where,
          create,
        }: {
          where: { groupId_userId: { groupId: string; userId: string } };
          create: GroupMemberRow;
        }) => {
          const { groupId, userId } = where.groupId_userId;
          const existing = store.groupMembers.find(
            (m) => m.groupId === groupId && m.userId === userId,
          );
          if (existing) return existing;
          const row: GroupMemberRow = { ...create, createdAt: new Date() };
          store.groupMembers.push(row);
          return row;
        },
        createMany: async ({
          data,
        }: {
          data: { groupId: string; userId: string; createdByUserId: string }[];
          skipDuplicates?: boolean;
        }) => {
          let count = 0;
          for (const d of data) {
            const exists = store.groupMembers.some(
              (m) => m.groupId === d.groupId && m.userId === d.userId,
            );
            if (exists) continue; // skipDuplicates
            store.groupMembers.push({ ...d, createdAt: new Date() });
            count++;
          }
          return { count };
        },
        deleteMany: async ({ where }: { where: GroupMemberWhere }) => {
          const rows = filterGroupMembers(where);
          const keys = new Set(rows.map((r) => `${r.groupId}:${r.userId}`));
          const before = store.groupMembers.length;
          store.groupMembers = store.groupMembers.filter(
            (m) => !keys.has(`${m.groupId}:${m.userId}`),
          );
          return { count: before - store.groupMembers.length };
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
      // The replace-set writer runs its delete+create under ONE array-form
      // transaction; the delete path is a plain conditional deleteMany.
      $transaction: async (arg: unknown) => {
        store.txCount++;
        if (typeof arg === "function") {
          return (arg as (tx: unknown) => Promise<unknown>)({ group: dbGroup });
        }
        return Promise.all(arg as Promise<unknown>[]);
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

const group = (
  id: string,
  name: string,
  overrides: Partial<GroupRow> = {},
): GroupRow => ({
  id,
  organizationId: ORG,
  name,
  source: "manual",
  externalId: null,
  createdAt: at(10),
  updatedAt: at(10),
  ...overrides,
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
    {
      id: OUTSIDER,
      externalAuthId: "ext-outsider",
      email: "outsider@other.test",
      name: "Odette Outsider",
    },
  ];
  store.members = [
    member(OWNER, "owner", at(0)),
    member(ADMIN, "admin", at(1)),
    member(MEMBER, "member", at(2)),
    member(OUTSIDER, "admin", at(3), OTHER_ORG),
  ];
  store.groups = [
    group("g-a", "Engineering", { createdAt: at(10), updatedAt: at(10) }),
    group("g-b", "Design", { createdAt: at(11), updatedAt: at(11) }),
    group("g-scim", "Provisioned", {
      source: "scim",
      externalId: "idp-77",
      createdAt: at(12),
      updatedAt: at(12),
    }),
    // A group in a DIFFERENT org — never visible through this org's routes.
    group("g-x", "Foreign", { organizationId: OTHER_ORG, createdAt: at(13) }),
  ];
  store.groupMembers = [
    {
      groupId: "g-a",
      userId: OWNER,
      createdByUserId: ADMIN,
      createdAt: at(20),
    },
    {
      groupId: "g-a",
      userId: ADMIN,
      createdByUserId: ADMIN,
      createdAt: at(21),
    },
    {
      groupId: "g-scim",
      userId: MEMBER,
      createdByUserId: null,
      createdAt: at(22),
    },
    // Membership of the foreign group, for cross-org isolation checks.
    {
      groupId: "g-x",
      userId: OUTSIDER,
      createdByUserId: null,
      createdAt: at(23),
    },
  ];
  store.projectAccess = [{ id: "pa-1", projectId: "proj-1", groupId: "g-a" }];
  store.audits = [];
  store.seq = 100;
  store.txCount = 0;
  store.race = false;
  store.sessionUserId = null;
});

const groupRow = (id: string) => store.groups.find((g) => g.id === id);
const membersOf = (groupId: string) =>
  store.groupMembers
    .filter((m) => m.groupId === groupId)
    .map((m) => m.userId)
    .sort();

const asAdmin = { headers: { Authorization: `Bearer ${ADMIN_KEY}` } };
const asProjectKey = { headers: { Authorization: `Bearer ${PROJECT_KEY}` } };

interface GroupListBody {
  data: {
    id: string;
    name: string;
    source: string;
    externalId: string | null;
    memberCount: number;
    createdAt: string;
    updatedAt: string;
  }[];
  nextCursor: string | null;
}

interface MemberListBody {
  data: {
    userId: string;
    email: string;
    name: string | null;
    addedAt: string;
  }[];
  nextCursor: string | null;
}

const list = async (query = ""): Promise<GroupListBody> => {
  const res = await app.request(`/v1/org/groups${query}`, asAdmin);
  expect(res.status).toBe(200);
  return (await res.json()) as GroupListBody;
};

const create = (body: unknown, init: RequestInit = asAdmin) =>
  app.request("/v1/org/groups", {
    ...init,
    method: "POST",
    body: JSON.stringify(body),
  });

const rename = (id: string, body: unknown, init: RequestInit = asAdmin) =>
  app.request(`/v1/org/groups/${id}`, {
    ...init,
    method: "PATCH",
    body: JSON.stringify(body),
  });

const remove = (id: string, init: RequestInit = asAdmin) =>
  app.request(`/v1/org/groups/${id}`, { ...init, method: "DELETE" });

const putMembers = (id: string, body: unknown, init: RequestInit = asAdmin) =>
  app.request(`/v1/org/groups/${id}/members`, {
    ...init,
    method: "PUT",
    body: JSON.stringify(body),
  });

const putMember = (id: string, userId: string, init: RequestInit = asAdmin) =>
  app.request(`/v1/org/groups/${id}/members/${userId}`, {
    ...init,
    method: "PUT",
    body: JSON.stringify({}),
  });

const deleteMember = (
  id: string,
  userId: string,
  init: RequestInit = asAdmin,
) =>
  app.request(`/v1/org/groups/${id}/members/${userId}`, {
    ...init,
    method: "DELETE",
  });

describe("GET /v1/org/groups", () => {
  it("returns the org's groups in the page envelope with member counts", async () => {
    const body = await list();
    expect(body.nextCursor).toBeNull();
    expect(body.data.map((row) => row.id)).toEqual(["g-a", "g-b", "g-scim"]);
    expect(body.data[0]).toEqual({
      id: "g-a",
      name: "Engineering",
      source: "manual",
      externalId: null,
      memberCount: 2,
      createdAt: at(10).toISOString(),
      updatedAt: at(10).toISOString(),
    });
    expect(body.data[2]).toMatchObject({
      source: "scim",
      externalId: "idp-77",
      memberCount: 1,
    });
  });

  it("never leaks groups of another organization", async () => {
    const body = await list();
    expect(body.data.some((row) => row.id === "g-x")).toBe(false);
  });

  it("filters by source", async () => {
    const body = await list("?source=scim");
    expect(body.data.map((r) => r.id)).toEqual(["g-scim"]);
    const manual = await list("?source=manual");
    expect(manual.data.map((r) => r.id)).toEqual(["g-a", "g-b"]);
  });

  it("rejects an unknown source with 422", async () => {
    const res = await app.request("/v1/org/groups?source=github", asAdmin);
    expect(res.status).toBe(422);
  });

  it("filters by free-text q over name, case-insensitively", async () => {
    const body = await list("?q=ENGINEER");
    expect(body.data.map((r) => r.id)).toEqual(["g-a"]);
  });

  it("pages with an opaque cursor and ends with nextCursor null", async () => {
    const first = await list("?limit=2");
    expect(first.data.map((r) => r.id)).toEqual(["g-a", "g-b"]);
    expect(first.nextCursor).toBeTruthy();

    const second = await list(
      `?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
    );
    expect(second.data.map((r) => r.id)).toEqual(["g-scim"]);
    expect(second.nextCursor).toBeNull();
  });

  it("walks every page exactly once when createdAt ties", async () => {
    // Same millisecond for all: only the id half of the cursor can separate
    // them, so a one-at-a-time walk is the tiebreak's real test.
    for (const row of store.groups) row.createdAt = at(7);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const body: GroupListBody = await list(
        `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      seen.push(...body.data.map((r) => r.id));
      cursor = body.nextCursor;
      if (!cursor) break;
    }

    expect(cursor).toBeNull();
    expect(seen.slice().sort()).toEqual(["g-a", "g-b", "g-scim"]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("treats a malformed cursor as the first page instead of failing", async () => {
    const body = await list("?cursor=not-a-real-cursor");
    expect(body.data).toHaveLength(3);
  });

  it("rejects out-of-range limits with 422", async () => {
    for (const limit of ["5000", "0", "abc"]) {
      const res = await app.request(`/v1/org/groups?limit=${limit}`, asAdmin);
      expect(res.status).toBe(422);
    }
  });

  it("403s a project-scoped key even when its user is an org owner", async () => {
    const res = await app.request("/v1/org/groups", asProjectKey);
    expect(res.status).toBe(403);
  });

  it("403s a non-admin member (deterministic, not a 401)", async () => {
    store.sessionUserId = MEMBER;
    const res = await app.request("/v1/org/groups");
    expect(res.status).toBe(403);
  });

  it("rejects a suspended admin's org key (suspended reads as no role)", async () => {
    const row = store.members.find((m) => m.userId === ADMIN);
    if (row) row.status = "suspended";
    const res = await app.request("/v1/org/groups", asAdmin);
    expect(res.status).toBe(401);
  });

  it("401s an unauthenticated caller", async () => {
    const res = await app.request("/v1/org/groups");
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/org/groups", () => {
  it("creates a manual group and audits it", async () => {
    const res = await create({ name: "Platform" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GroupListBody["data"][number];
    expect(body).toMatchObject({
      name: "Platform",
      source: "manual",
      externalId: null,
      memberCount: 0,
    });
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({
      organizationId: ORG,
      userId: ADMIN,
      action: "create",
      service: "group",
      source: "api",
      metadata: { groupId: body.id, name: "Platform" },
    });
  });

  it("ignores body source/externalId: creates are always manual", async () => {
    const res = await create({
      name: "Sneaky",
      source: "scim",
      externalId: "idp-evil",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GroupListBody["data"][number];
    expect(body.source).toBe("manual");
    expect(body.externalId).toBeNull();
    expect(groupRow(body.id)?.source).toBe("manual");
  });

  it("trims the name before storing", async () => {
    const res = await create({ name: "  Padded  " });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GroupListBody["data"][number];
    expect(body.name).toBe("Padded");
  });

  it("422s an empty / whitespace-only / overlong / missing name", async () => {
    for (const body of [
      { name: "" },
      { name: "   " },
      { name: "x".repeat(101) },
      {},
    ]) {
      const res = await create(body);
      expect(res.status).toBe(422);
    }
    expect(store.audits).toHaveLength(0);
  });

  it("422s a missing/unparseable body", async () => {
    const res = await app.request("/v1/org/groups", {
      ...asAdmin,
      method: "POST",
    });
    expect(res.status).toBe(422);
  });

  it("409s a duplicate name and audits nothing", async () => {
    const res = await create({ name: "Engineering" });
    expect(res.status).toBe(409);
    expect(store.audits).toHaveLength(0);
    expect(store.groups.filter((g) => g.name === "Engineering")).toHaveLength(
      1,
    );
  });

  it("409s a create-create race surfaced as P2002", async () => {
    store.race = true;
    const res = await create({ name: "Engineering" });
    expect(res.status).toBe(409);
    expect(store.audits).toHaveLength(0);
  });

  it("403s a project-scoped key and audits/creates nothing", async () => {
    const res = await create({ name: "Platform" }, asProjectKey);
    expect(res.status).toBe(403);
    expect(store.audits).toHaveLength(0);
    expect(store.groups.some((g) => g.name === "Platform")).toBe(false);
  });

  it("403s a non-admin member and audits nothing", async () => {
    store.sessionUserId = MEMBER;
    const res = await create({ name: "Platform" }, {});
    expect(res.status).toBe(403);
    expect(store.audits).toHaveLength(0);
  });
});

describe("PATCH /v1/org/groups/:groupId", () => {
  it("renames a group and audits the change discriminator", async () => {
    const res = await rename("g-a", { name: "Core Engineering" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GroupListBody["data"][number];
    expect(body).toMatchObject({
      id: "g-a",
      name: "Core Engineering",
      memberCount: 2,
    });
    expect(groupRow("g-a")?.name).toBe("Core Engineering");
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({
      action: "update",
      service: "group",
      metadata: { groupId: "g-a", change: "name", name: "Core Engineering" },
    });
  });

  it("permits a rename-to-self as a no-op 200", async () => {
    const res = await rename("g-a", { name: "Engineering" });
    expect(res.status).toBe(200);
    expect(groupRow("g-a")?.name).toBe("Engineering");
  });

  it("409s a rename onto another group's name", async () => {
    const res = await rename("g-a", { name: "Design" });
    expect(res.status).toBe(409);
    expect(groupRow("g-a")?.name).toBe("Engineering");
    expect(store.audits).toHaveLength(0);
  });

  it("404s an unknown group", async () => {
    const res = await rename("g-nope", { name: "Anything" });
    expect(res.status).toBe(404);
  });

  it("404s a group of another organization (cross-org isolation)", async () => {
    const res = await rename("g-x", { name: "Captured" });
    expect(res.status).toBe(404);
    expect(groupRow("g-x")?.name).toBe("Foreign");
  });

  it("409s a scim-provisioned group (IdP-owned)", async () => {
    const res = await rename("g-scim", { name: "Mine now" });
    expect(res.status).toBe(409);
    expect(groupRow("g-scim")?.name).toBe("Provisioned");
    expect(store.audits).toHaveLength(0);
  });

  it("422s an invalid name", async () => {
    const res = await rename("g-a", { name: "   " });
    expect(res.status).toBe(422);
  });
});

describe("DELETE /v1/org/groups/:groupId", () => {
  it("deletes, reports the impact read BEFORE the delete, and cascades", async () => {
    const res = await remove("g-a");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "g-a",
      name: "Engineering",
      removedMembers: 2,
      removedProjectBindings: 1,
    });
    // Cascades applied: membership and project bindings went with the group.
    expect(groupRow("g-a")).toBeUndefined();
    expect(membersOf("g-a")).toEqual([]);
    expect(store.projectAccess.some((pa) => pa.groupId === "g-a")).toBe(false);
  });

  it("audits counts only — never id arrays", async () => {
    const res = await remove("g-a");
    expect(res.status).toBe(200);
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({
      action: "delete",
      service: "group",
      metadata: {
        groupId: "g-a",
        name: "Engineering",
        removedMembers: 2,
        removedProjectBindings: 1,
      },
    });
    for (const value of Object.values(store.audits[0]?.metadata ?? {})) {
      expect(Array.isArray(value)).toBe(false);
    }
  });

  it("404s an unknown group and audits nothing", async () => {
    const res = await remove("g-nope");
    expect(res.status).toBe(404);
    expect(store.audits).toHaveLength(0);
  });

  it("404s a group of another organization (cross-org isolation)", async () => {
    const res = await remove("g-x");
    expect(res.status).toBe(404);
    expect(groupRow("g-x")).toBeTruthy();
  });

  it("409s a scim-provisioned group", async () => {
    const res = await remove("g-scim");
    expect(res.status).toBe(409);
    expect(groupRow("g-scim")).toBeTruthy();
  });

  it("403s a project-scoped key and deletes nothing", async () => {
    const res = await remove("g-a", asProjectKey);
    expect(res.status).toBe(403);
    expect(groupRow("g-a")).toBeTruthy();
    expect(store.audits).toHaveLength(0);
  });
});

describe("GET /v1/org/groups/:groupId/members", () => {
  const listMembers = async (
    groupId: string,
    query = "",
  ): Promise<MemberListBody> => {
    const res = await app.request(
      `/v1/org/groups/${groupId}/members${query}`,
      asAdmin,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as MemberListBody;
  };

  it("returns the group's members with user identity joined in", async () => {
    const body = await listMembers("g-a");
    expect(body.nextCursor).toBeNull();
    expect(body.data).toEqual([
      {
        userId: OWNER,
        email: "owner@example.com",
        name: "Olive Owner",
        addedAt: at(20).toISOString(),
      },
      {
        userId: ADMIN,
        email: "admin@example.com",
        name: "Adam Admin",
        addedAt: at(21).toISOString(),
      },
    ]);
  });

  it("filters by q over email and name, case-insensitively", async () => {
    const byEmail = await listMembers("g-a", "?q=OWNER@example");
    expect(byEmail.data.map((r) => r.userId)).toEqual([OWNER]);
    const byName = await listMembers("g-a", "?q=adam");
    expect(byName.data.map((r) => r.userId)).toEqual([ADMIN]);
  });

  it("pages the member list with the two-part cursor", async () => {
    const first = await listMembers("g-a", "?limit=1");
    expect(first.data.map((r) => r.userId)).toEqual([OWNER]);
    expect(first.nextCursor).toBeTruthy();
    const second = await listMembers(
      "g-a",
      `?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
    );
    expect(second.data.map((r) => r.userId)).toEqual([ADMIN]);
    expect(second.nextCursor).toBeNull();
  });

  it("404s a group of another organization (no membership oracle)", async () => {
    const res = await app.request("/v1/org/groups/g-x/members", asAdmin);
    expect(res.status).toBe(404);
  });

  it("lists a scim group's members (reads are always allowed)", async () => {
    const body = await listMembers("g-scim");
    expect(body.data.map((r) => r.userId)).toEqual([MEMBER]);
  });
});

describe("PUT /v1/org/groups/:groupId/members (replace-set)", () => {
  it("applies the exact set: adds, removes, keeps, and returns the delta", async () => {
    // g-a currently {OWNER, ADMIN}; target {ADMIN, MEMBER}.
    const res = await putMembers("g-a", { userIds: [ADMIN, MEMBER] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: 1, removed: 1 });
    expect(membersOf("g-a")).toEqual([ADMIN, MEMBER].sort());
    expect(store.txCount).toBe(1);
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({
      action: "update",
      service: "group",
      source: "api",
      metadata: { groupId: "g-a", change: "members", added: 1, removed: 1 },
    });
    // Counts only, never id arrays.
    for (const value of Object.values(store.audits[0]?.metadata ?? {})) {
      expect(Array.isArray(value)).toBe(false);
    }
  });

  it("an empty set clears the group", async () => {
    const res = await putMembers("g-a", { userIds: [] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: 0, removed: 2 });
    expect(membersOf("g-a")).toEqual([]);
  });

  it("a no-op set returns {0,0} without opening a transaction", async () => {
    const res = await putMembers("g-a", { userIds: [OWNER, ADMIN] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: 0, removed: 0 });
    expect(store.txCount).toBe(0);
    expect(membersOf("g-a")).toEqual([ADMIN, OWNER].sort());
  });

  it("deduplicates repeated ids in the payload", async () => {
    const res = await putMembers("g-b", { userIds: [MEMBER, MEMBER] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: 1, removed: 0 });
    expect(membersOf("g-b")).toEqual([MEMBER]);
  });

  it("422s a set beyond the cap", async () => {
    const userIds = Array.from({ length: 1001 }, (_, i) => `u-${i}`);
    const res = await putMembers("g-a", { userIds });
    expect(res.status).toBe(422);
  });

  it("400s when ANY id is not a member of this org — the security core", async () => {
    const res = await putMembers("g-a", { userIds: [ADMIN, OUTSIDER] });
    expect(res.status).toBe(400);
    // Nothing written, nothing audited: the whole write is rejected.
    expect(membersOf("g-a")).toEqual([ADMIN, OWNER].sort());
    expect(store.audits).toHaveLength(0);
    expect(store.txCount).toBe(0);
  });

  it("allows suspended members (suspension is an auth-time gate)", async () => {
    const row = store.members.find((m) => m.userId === MEMBER);
    if (row) row.status = "suspended";
    const res = await putMembers("g-b", { userIds: [MEMBER] });
    expect(res.status).toBe(200);
    expect(membersOf("g-b")).toEqual([MEMBER]);
  });

  it("404s a cross-org group before validating membership", async () => {
    const res = await putMembers("g-x", { userIds: [OUTSIDER] });
    expect(res.status).toBe(404);
    expect(membersOf("g-x")).toEqual([OUTSIDER]);
  });

  it("409s a scim group (membership is IdP-owned)", async () => {
    const res = await putMembers("g-scim", { userIds: [ADMIN] });
    expect(res.status).toBe(409);
    expect(membersOf("g-scim")).toEqual([MEMBER]);
  });

  it("422s a malformed body", async () => {
    for (const body of [{}, { userIds: "ADMIN" }, { userIds: [""] }, null]) {
      const res = await putMembers("g-a", body);
      expect(res.status).toBe(422);
    }
  });

  it("403s a non-admin and writes/audits nothing", async () => {
    store.sessionUserId = MEMBER;
    const res = await putMembers("g-a", { userIds: [] }, {});
    expect(res.status).toBe(403);
    expect(membersOf("g-a")).toEqual([ADMIN, OWNER].sort());
    expect(store.audits).toHaveLength(0);
  });
});

describe("PUT /v1/org/groups/:groupId/members/:userId (single add)", () => {
  it("adds a member, returns a JSON body, and audits", async () => {
    const res = await putMember("g-b", MEMBER);
    expect(res.status).toBe(200);
    // apiPut ALWAYS parses the response — a 204 here would break the client.
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ added: true });
    expect(membersOf("g-b")).toEqual([MEMBER]);
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({
      metadata: {
        groupId: "g-b",
        change: "members",
        userId: MEMBER,
        added: true,
      },
    });
  });

  it("is idempotent: a second add reports added: false", async () => {
    expect((await putMember("g-b", MEMBER)).status).toBe(200);
    const res = await putMember("g-b", MEMBER);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: false });
    expect(membersOf("g-b")).toEqual([MEMBER]);
  });

  it("400s a user from another organization", async () => {
    const res = await putMember("g-b", OUTSIDER);
    expect(res.status).toBe(400);
    expect(membersOf("g-b")).toEqual([]);
    expect(store.audits).toHaveLength(0);
  });

  it("404s a cross-org group / 409s a scim group", async () => {
    expect((await putMember("g-x", MEMBER)).status).toBe(404);
    expect((await putMember("g-scim", ADMIN)).status).toBe(409);
  });
});

describe("DELETE /v1/org/groups/:groupId/members/:userId (single remove)", () => {
  it("removes a member and audits", async () => {
    const res = await deleteMember("g-a", OWNER);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true });
    expect(membersOf("g-a")).toEqual([ADMIN]);
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({
      metadata: {
        groupId: "g-a",
        change: "members",
        userId: OWNER,
        removed: true,
      },
    });
  });

  it("is idempotent: a missing membership is removed:false, not 404", async () => {
    const res = await deleteMember("g-b", MEMBER);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: false });
  });

  it("404s only for a missing/cross-org GROUP", async () => {
    expect((await deleteMember("g-nope", MEMBER)).status).toBe(404);
    expect((await deleteMember("g-x", OUTSIDER)).status).toBe(404);
    expect(membersOf("g-x")).toEqual([OUTSIDER]);
  });

  it("409s a scim group", async () => {
    const res = await deleteMember("g-scim", MEMBER);
    expect(res.status).toBe(409);
    expect(membersOf("g-scim")).toEqual([MEMBER]);
  });
});
