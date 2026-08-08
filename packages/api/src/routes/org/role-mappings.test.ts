import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../../types";

// `/v1/org/role-mappings` end-to-end through the real app: the OSS org routes
// mounted on the `eeRoutes` seam, the OSS role resolver wired as the
// RoleResolver, and `CAPS.rbac` on. Admin callers arrive with an org API key
// (whose key path re-checks admin through the resolver); the non-admin cases
// use a session, since a non-admin's org key fails key authentication
// outright. (Same harness as groups.test.ts — cloned, not shared.)
//
// The apply engine is exercised THROUGH these routes, so the mock has to be
// honest about two things or the security tests prove nothing: the
// `role: { not: "owner" }` predicate on `organizationMember.updateMany`, and
// the difference between the two `$transaction` forms (see the counters).

const ORG = "org-1";
const OTHER_ORG = "org-2";
const OWNER = "user-owner";
const ADMIN = "user-admin";
const MEMBER = "user-member";
const MEMBER2 = "user-member-2";
const SUSPENDED = "user-suspended";
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
  createdAt: Date;
}

interface MappingRow {
  id: string;
  organizationId: string;
  groupId: string;
  role: string;
  priority: number;
  createdAt: Date;
  updatedAt: Date;
}

interface AuditRow {
  organizationId?: string;
  userId: string;
  userEmail: string;
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
  roleMappings: [] as MappingRow[],
  audits: [] as AuditRow[],
  seq: 0,
  /** Array-form `$transaction` — the APPLY's role writes. */
  txCount: 0,
  /** Interactive `$transaction` — the advisory-locked create/reorder. */
  lockedTxCount: 0,
  /** Simulate a create-create race: the pre-check misses, create P2002s. */
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

  interface GroupWhere {
    id?: string;
    organizationId?: string;
  }
  interface GroupMemberWhere {
    groupId?: string | { in: string[] };
    userId?: { in: string[] };
  }
  interface MappingWhere {
    id?: string;
    organizationId?: string;
    groupId?: string;
  }
  interface MappingSelect {
    id?: boolean;
    organizationId?: boolean;
    groupId?: boolean;
    role?: boolean;
    priority?: boolean;
    createdAt?: boolean;
    updatedAt?: boolean;
    group?: {
      select: { name?: boolean; _count?: { select: { members?: boolean } } };
    };
  }
  interface MemberWhere {
    organizationId?: string;
    userId?: string | { in: string[] };
    role?: string | { not?: string };
    status?: string | { not?: string };
  }

  const matchesRole = (row: MemberRow, where: MemberWhere) => {
    if (where.role === undefined) return true;
    if (typeof where.role === "string") return row.role === where.role;
    return where.role.not === undefined || row.role !== where.role.not;
  };

  const filterMembers = (where: MemberWhere) =>
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
      return matchesRole(row, where);
    });

  const pickMember = (
    row: MemberRow,
    select?: { userId?: boolean; role?: boolean; userEmail?: boolean },
  ) => {
    if (!select) return { ...row };
    const picked: Record<string, unknown> = {};
    if (select.userId) picked.userId = row.userId;
    if (select.role) picked.role = row.role;
    if (select.userEmail) picked.userEmail = row.userEmail;
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
      if (where.userId !== undefined && !where.userId.in.includes(row.userId))
        return false;
      return true;
    });

  const filterMappings = (where: MappingWhere = {}) =>
    store.roleMappings.filter((row) => {
      if (where.id !== undefined && row.id !== where.id) return false;
      if (
        where.organizationId !== undefined &&
        row.organizationId !== where.organizationId
      )
        return false;
      if (where.groupId !== undefined && row.groupId !== where.groupId)
        return false;
      return true;
    });

  // The ONE resolution order: priority asc, createdAt asc, id asc.
  const sortMappings = (rows: MappingRow[]) =>
    rows
      .slice()
      .sort(
        (a, b) =>
          a.priority - b.priority ||
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      );

  const pickMapping = (row: MappingRow, select?: MappingSelect) => {
    if (!select) return { ...row };
    const picked: Record<string, unknown> = {};
    for (const key of [
      "id",
      "organizationId",
      "groupId",
      "role",
      "priority",
      "createdAt",
      "updatedAt",
    ] as const) {
      if (select[key]) picked[key] = row[key];
    }
    if (select.group) {
      const group = store.groups.find((g) => g.id === row.groupId);
      const relation: Record<string, unknown> = {};
      if (select.group.select.name) relation.name = group?.name ?? "";
      if (select.group.select._count) {
        relation._count = {
          members: store.groupMembers.filter((m) => m.groupId === row.groupId)
            .length,
        };
      }
      picked.group = relation;
    }
    return picked;
  };

  const dbClient = {
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
        select,
      }: {
        where: {
          organizationId_userId: { organizationId: string; userId: string };
        };
        select?: { userId?: boolean; role?: boolean; userEmail?: boolean };
      }) => {
        const { organizationId, userId } = where.organizationId_userId;
        const row = store.members.find(
          (m) => m.organizationId === organizationId && m.userId === userId,
        );
        // The role resolver reads role+status off the whole row.
        return row ? (select ? pickMember(row, select) : { ...row }) : null;
      },
      findFirst: async ({ where }: { where: MemberWhere }) =>
        filterMembers(where)[0] ?? null,
      findMany: async ({
        where,
        select,
      }: {
        where: MemberWhere;
        select?: { userId?: boolean; role?: boolean; userEmail?: boolean };
      }) => filterMembers(where).map((row) => pickMember(row, select)),
      // THE last-owner invariant at the write layer: the predicate is honoured
      // here, or the "a mapping can never strip the last owner" tests would be
      // testing the mock rather than the service.
      updateMany: async ({
        where,
        data,
      }: {
        where: MemberWhere;
        data: { role: string };
      }) => {
        const rows = filterMembers(where);
        for (const row of rows) row.role = data.role;
        return { count: rows.length };
      },
      count: async () => 0,
    },
    group: {
      findFirst: async ({
        where,
        select,
      }: {
        where: GroupWhere;
        select?: { id?: boolean; name?: boolean };
      }) => {
        const row = store.groups.find(
          (g) =>
            (where.id === undefined || g.id === where.id) &&
            (where.organizationId === undefined ||
              g.organizationId === where.organizationId),
        );
        if (!row) return null;
        if (!select) return { ...row };
        const picked: Record<string, unknown> = {};
        if (select.id) picked.id = row.id;
        if (select.name) picked.name = row.name;
        return picked;
      },
      findMany: async () => [],
    },
    groupMember: {
      findMany: async ({
        where,
        select,
      }: {
        where: GroupMemberWhere;
        select?: { groupId?: boolean; userId?: boolean };
      }) =>
        filterGroupMembers(where).map((row) => {
          if (!select) return { ...row };
          const picked: Record<string, unknown> = {};
          if (select.groupId) picked.groupId = row.groupId;
          if (select.userId) picked.userId = row.userId;
          return picked;
        }),
    },
    groupRoleMapping: {
      findFirst: async ({
        where,
        select,
      }: {
        where: MappingWhere;
        select?: MappingSelect;
      }) => {
        // Race simulation: the create pre-check (a groupId-keyed findFirst
        // with no id) misses, so the create itself must surface the P2002.
        if (store.race && where.groupId !== undefined && where.id === undefined)
          return null;
        const row = sortMappings(filterMappings(where))[0];
        return row ? pickMapping(row, select) : null;
      },
      findMany: async ({
        where,
        select,
      }: {
        where: MappingWhere;
        select?: MappingSelect;
      }) =>
        sortMappings(filterMappings(where)).map((row) =>
          pickMapping(row, select),
        ),
      count: async ({ where }: { where: MappingWhere }) =>
        filterMappings(where).length,
      aggregate: async ({ where }: { where: MappingWhere }) => {
        const rows = filterMappings(where);
        return {
          _max: {
            priority: rows.length
              ? Math.max(...rows.map((r) => r.priority))
              : null,
          },
        };
      },
      create: async ({
        data,
        select,
      }: {
        data: {
          organizationId: string;
          groupId: string;
          role: string;
          priority: number;
        };
        select?: MappingSelect;
      }) => {
        // `groupId` is @unique — at most one mapping per group.
        if (store.roleMappings.some((m) => m.groupId === data.groupId)) {
          throw new PrismaClientKnownRequestError(
            "Unique constraint failed",
            "P2002",
          );
        }
        const row: MappingRow = {
          id: `rm-${++store.seq}`,
          organizationId: data.organizationId,
          groupId: data.groupId,
          role: data.role,
          priority: data.priority,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        store.roleMappings.push(row);
        return pickMapping(row, select);
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { priority?: number; role?: string };
      }) => {
        const row = store.roleMappings.find((m) => m.id === where.id);
        if (!row)
          throw new PrismaClientKnownRequestError("Record not found", "P2025");
        if (data.priority !== undefined) row.priority = data.priority;
        if (data.role !== undefined) row.role = data.role;
        row.updatedAt = new Date();
        return { ...row };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: MappingWhere;
        data: { role?: string; priority?: number };
      }) => {
        const rows = filterMappings(where);
        for (const row of rows) {
          if (data.role !== undefined) row.role = data.role;
          if (data.priority !== undefined) row.priority = data.priority;
          row.updatedAt = new Date();
        }
        return { count: rows.length };
      },
      deleteMany: async ({ where }: { where: MappingWhere }) => {
        const rows = filterMappings(where);
        const ids = new Set(rows.map((r) => r.id));
        store.roleMappings = store.roleMappings.filter((m) => !ids.has(m.id));
        return { count: rows.length };
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
    // Both forms, counted SEPARATELY: the apply batches its role writes as an
    // array, while create/reorder open an interactive one to take the
    // advisory lock. "No apply transaction was opened" is `txCount`.
    $transaction: async (arg: unknown) => {
      if (typeof arg === "function") {
        store.lockedTxCount++;
        return (arg as (tx: unknown) => Promise<unknown>)(dbClient);
      }
      store.txCount++;
      return Promise.all(arg as Promise<unknown>[]);
    },
    /** The advisory lock — a no-op tagged-template stub. */
    $executeRaw: async () => 1,
  };

  return {
    Prisma: { JsonNull: null, PrismaClientKnownRequestError },
    db: dbClient,
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
  userEmail: `${userId}@example.com`,
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

const mapping = (
  id: string,
  groupId: string,
  role: string,
  priority: number,
  organizationId = ORG,
): MappingRow => ({
  id,
  organizationId,
  groupId,
  role,
  priority,
  createdAt: at(30 + priority),
  updatedAt: at(30 + priority),
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
      email: "member@example.com",
      name: null,
    },
    {
      id: MEMBER2,
      externalAuthId: "ext-member-2",
      email: "member2@example.com",
      name: null,
    },
    {
      id: SUSPENDED,
      externalAuthId: "ext-suspended",
      email: "suspended@example.com",
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
    member(MEMBER2, "member", at(3)),
    { ...member(SUSPENDED, "member", at(4)), status: "suspended" },
    member(OUTSIDER, "admin", at(5), OTHER_ORG),
  ];
  store.groups = [
    group("g-a", "Engineering"),
    group("g-b", "Design", { createdAt: at(11), updatedAt: at(11) }),
    group("g-c", "Everyone", { createdAt: at(12), updatedAt: at(12) }),
    group("g-scim", "Provisioned", {
      source: "scim",
      externalId: "idp-77",
      createdAt: at(13),
      updatedAt: at(13),
    }),
    // A group in a DIFFERENT org — never visible through this org's routes.
    group("g-x", "Foreign", { organizationId: OTHER_ORG, createdAt: at(14) }),
  ];
  store.groupMembers = [
    { groupId: "g-a", userId: OWNER, createdAt: at(20) },
    { groupId: "g-a", userId: ADMIN, createdAt: at(21) },
    { groupId: "g-a", userId: MEMBER, createdAt: at(22) },
    { groupId: "g-b", userId: MEMBER2, createdAt: at(23) },
    { groupId: "g-b", userId: SUSPENDED, createdAt: at(24) },
    { groupId: "g-c", userId: MEMBER, createdAt: at(25) },
    { groupId: "g-c", userId: MEMBER2, createdAt: at(26) },
    { groupId: "g-scim", userId: MEMBER, createdAt: at(27) },
    { groupId: "g-x", userId: OUTSIDER, createdAt: at(28) },
  ];
  // A CONVERGED baseline: the only mapping grants `member`, which nobody can
  // be raised to, so any apply over the untouched fixture is a no-op.
  store.roleMappings = [
    mapping("rm-1", "g-b", "member", 0),
    mapping("rm-x", "g-x", "admin", 0, OTHER_ORG),
  ];
  store.audits = [];
  store.seq = 100;
  store.txCount = 0;
  store.lockedTxCount = 0;
  store.race = false;
  store.sessionUserId = null;
});

const asAdmin = { headers: { Authorization: `Bearer ${ADMIN_KEY}` } };
const asProjectKey = { headers: { Authorization: `Bearer ${PROJECT_KEY}` } };

interface RoleMappingBody {
  id: string;
  groupId: string;
  groupName: string;
  role: string;
  priority: number;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

const base = "/v1/org/role-mappings";

const list = async (init: RequestInit = asAdmin) =>
  app.request(base, init) as Promise<Response>;

const listRows = async (): Promise<RoleMappingBody[]> => {
  const res = await list();
  expect(res.status).toBe(200);
  return (await res.json()) as RoleMappingBody[];
};

const create = (body: unknown, init: RequestInit = asAdmin) =>
  app.request(base, { ...init, method: "POST", body: JSON.stringify(body) });

const update = (id: string, body: unknown, init: RequestInit = asAdmin) =>
  app.request(`${base}/${id}`, {
    ...init,
    method: "PATCH",
    body: JSON.stringify(body),
  });

const remove = (id: string, init: RequestInit = asAdmin) =>
  app.request(`${base}/${id}`, { ...init, method: "DELETE" });

const reorder = (orderedIds: string[], init: RequestInit = asAdmin) =>
  app.request(`${base}/order`, {
    ...init,
    method: "PUT",
    body: JSON.stringify({ orderedIds }),
  });

const preview = (body: unknown, init: RequestInit = asAdmin) =>
  app.request(`${base}/preview`, {
    ...init,
    method: "POST",
    body: JSON.stringify(body),
  });

const roleOf = (userId: string) =>
  store.members.find((m) => m.organizationId === ORG && m.userId === userId)
    ?.role;

const activeOwners = () =>
  store.members.filter(
    (m) =>
      m.organizationId === ORG &&
      m.role === "owner" &&
      m.status !== "suspended",
  );

const memberAudits = () => store.audits.filter((a) => a.service === "member");
const mappingAudits = () =>
  store.audits.filter((a) => a.service === "role-mapping");

describe("the guard stack", () => {
  it("401s an unauthenticated caller", async () => {
    const res = await app.request(base);
    expect(res.status).toBe(401);
  });

  it("403s a non-admin member (deterministic, not a 401)", async () => {
    store.sessionUserId = MEMBER;
    const res = await app.request(base);
    expect(res.status).toBe(403);
  });

  it("403s a project-scoped key on EVERY verb, even for an org owner", async () => {
    const responses = await Promise.all([
      list(asProjectKey),
      create({ groupId: "g-a", role: "admin" }, asProjectKey),
      update("rm-1", { role: "admin" }, asProjectKey),
      remove("rm-1", asProjectKey),
      reorder(["rm-1"], asProjectKey),
      preview({ groupId: "g-a", role: "admin" }, asProjectKey),
    ]);
    for (const res of responses) expect(res.status).toBe(403);
    expect(store.audits).toHaveLength(0);
    expect(roleOf(MEMBER)).toBe("member");
  });
});

describe("GET /v1/org/role-mappings", () => {
  it("returns a BARE ARRAY (not a page envelope) — the client contract", async () => {
    const res = await list();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("orders by priority ascending and carries groupName + memberCount", async () => {
    store.roleMappings.push(mapping("rm-2", "g-a", "admin", 5));
    store.roleMappings.push(mapping("rm-3", "g-c", "member", 2));
    const rows = await listRows();
    expect(rows.map((r) => r.id)).toEqual(["rm-1", "rm-3", "rm-2"]);
    expect(rows[0]).toEqual({
      id: "rm-1",
      groupId: "g-b",
      groupName: "Design",
      role: "member",
      priority: 0,
      memberCount: 2,
      createdAt: at(30).toISOString(),
      updatedAt: at(30).toISOString(),
    });
  });

  it("never leaks another organization's mappings", async () => {
    const rows = await listRows();
    expect(rows.some((r) => r.id === "rm-x")).toBe(false);
  });
});

describe("POST /v1/org/role-mappings", () => {
  it("creates a mapping, appends at max+1, and audits it", async () => {
    const res = await create({ groupId: "g-c", role: "admin" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RoleMappingBody;
    expect(body).toMatchObject({
      groupId: "g-c",
      groupName: "Everyone",
      role: "admin",
      priority: 1, // rm-1 sits at 0
      memberCount: 2,
    });
    expect(mappingAudits()).toHaveLength(1);
    expect(mappingAudits()[0]).toMatchObject({
      organizationId: ORG,
      userId: ADMIN,
      action: "create",
      service: "role-mapping",
      source: "api",
      metadata: {
        mappingId: body.id,
        groupId: "g-c",
        groupName: "Everyone",
        role: "admin",
        priority: 1,
        // g-c is {MEMBER, MEMBER2}, but MEMBER2 is also in g-b whose `member`
        // mapping sits at priority 0 and shadows this one.
        rolesChanged: 1,
      },
    });
    expect(roleOf(MEMBER)).toBe("admin");
    expect(roleOf(MEMBER2)).toBe("member");
  });

  it("uses priority 0 for the org's FIRST mapping", async () => {
    store.roleMappings = store.roleMappings.filter((m) => m.id === "rm-x");
    const res = await create({ groupId: "g-c", role: "member" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as RoleMappingBody).priority).toBe(0);
  });

  it("honours an explicit priority", async () => {
    const res = await create({ groupId: "g-c", role: "member", priority: 7 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as RoleMappingBody).priority).toBe(7);
  });

  // `priority` is NOT coerced: a body that meant "no priority" must 422, not
  // land in slot 0 — the highest-precedence slot, which shadows everything.
  it("422s a non-numeric priority instead of reading it as 0", async () => {
    for (const priority of [null, "", false, [], "3"]) {
      const res = await create({ groupId: "g-c", role: "admin", priority });
      expect(res.status).toBe(422);
    }
    expect(store.roleMappings.some((m) => m.groupId === "g-c")).toBe(false);
    expect(store.audits).toHaveLength(0);
  });

  it("409s once the org is at the mapping ceiling, keeping PUT /order reachable", async () => {
    store.roleMappings = Array.from({ length: 500 }, (_, i) =>
      mapping(`rm-bulk-${i}`, `g-bulk-${i}`, "member", i),
    );
    const res = await create({ groupId: "g-a", role: "admin" });
    expect(res.status).toBe(409);
    expect(store.roleMappings).toHaveLength(500);
    expect(store.audits).toHaveLength(0);
  });

  it("409s a second mapping for the same group (groupId is unique)", async () => {
    const res = await create({ groupId: "g-b", role: "admin" });
    expect(res.status).toBe(409);
    expect(store.audits).toHaveLength(0);
    expect(store.roleMappings.filter((m) => m.groupId === "g-b")).toHaveLength(
      1,
    );
  });

  it("409s a create-create race surfaced as P2002", async () => {
    store.race = true;
    const res = await create({ groupId: "g-b", role: "admin" });
    expect(res.status).toBe(409);
    expect(store.audits).toHaveLength(0);
  });

  it("422s role: owner — mappings can never mint an owner", async () => {
    const res = await create({ groupId: "g-c", role: "owner" });
    expect(res.status).toBe(422);
    expect(store.audits).toHaveLength(0);
    expect(store.roleMappings.some((m) => m.groupId === "g-c")).toBe(false);
  });

  it("422s a malformed body", async () => {
    for (const body of [{}, { groupId: "g-c" }, { role: "admin" }, null]) {
      expect((await create(body)).status).toBe(422);
    }
  });

  it("404s an unknown group and a group of another organization", async () => {
    expect((await create({ groupId: "g-nope", role: "admin" })).status).toBe(
      404,
    );
    expect((await create({ groupId: "g-x", role: "admin" })).status).toBe(404);
    expect(store.roleMappings.filter((m) => m.groupId === "g-x")).toHaveLength(
      1,
    );
  });

  it("MAPS a scim-provisioned group: a mapping is a OneCLI artifact, not an IdP one", async () => {
    const res = await create({ groupId: "g-scim", role: "admin" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as RoleMappingBody).groupId).toBe("g-scim");
    expect(roleOf(MEMBER)).toBe("admin");
  });
});

describe("PATCH /v1/org/role-mappings/:id", () => {
  it("changes the role, audits the discriminator, and re-applies", async () => {
    const res = await update("rm-1", { role: "admin" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RoleMappingBody;
    expect(body).toMatchObject({ id: "rm-1", role: "admin", priority: 0 });
    expect(mappingAudits()[0]).toMatchObject({
      action: "update",
      service: "role-mapping",
      metadata: {
        mappingId: "rm-1",
        groupId: "g-b",
        change: "role",
        role: "admin",
        rolesChanged: 2,
      },
    });
  });

  it("accepts an optional priority and records change: role+priority", async () => {
    const res = await update("rm-1", { role: "member", priority: 9 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as RoleMappingBody).priority).toBe(9);
    expect(mappingAudits()[0]?.metadata).toMatchObject({
      change: "role+priority",
      priority: 9,
    });
  });

  it("404s an unknown id and another org's mapping", async () => {
    expect((await update("rm-nope", { role: "admin" })).status).toBe(404);
    expect((await update("rm-x", { role: "member" })).status).toBe(404);
    expect(store.roleMappings.find((m) => m.id === "rm-x")?.role).toBe("admin");
  });

  it("422s role: owner", async () => {
    expect((await update("rm-1", { role: "owner" })).status).toBe(422);
    expect(store.roleMappings.find((m) => m.id === "rm-1")?.role).toBe(
      "member",
    );
  });
});

describe("DELETE /v1/org/role-mappings/:id", () => {
  it("removes the row, returns a JSON body, and audits", async () => {
    const res = await remove("rm-1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      id: "rm-1",
      groupId: "g-b",
      role: "member",
      rolesChanged: 0,
    });
    expect(store.roleMappings.some((m) => m.id === "rm-1")).toBe(false);
    expect(mappingAudits()[0]).toMatchObject({
      action: "delete",
      service: "role-mapping",
      source: "api",
      metadata: { mappingId: "rm-1", groupId: "g-b", role: "member" },
    });
  });

  it("404s an unknown id and another org's mapping", async () => {
    expect((await remove("rm-nope")).status).toBe(404);
    expect((await remove("rm-x")).status).toBe(404);
    expect(store.roleMappings.some((m) => m.id === "rm-x")).toBe(true);
  });

  it("UNSHADOWS: deleting the priority-0 member mapping promotes the suppressed", async () => {
    // g-c (Everyone → member) at 0 shadows g-a (Engineering → admin) at 1.
    store.roleMappings = [
      mapping("rm-shadow", "g-c", "member", 0),
      mapping("rm-eng", "g-a", "admin", 1),
    ];
    expect(roleOf(MEMBER)).toBe("member");

    const res = await remove("rm-shadow");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rolesChanged: 1 });
    // MEMBER is in both groups; with the shadow gone the admin mapping wins.
    expect(roleOf(MEMBER)).toBe("admin");
    // MEMBER2 is only in g-c, which no longer has a mapping.
    expect(roleOf(MEMBER2)).toBe("member");
  });
});

describe("PUT /v1/org/role-mappings/order", () => {
  beforeEach(() => {
    store.roleMappings = [
      mapping("rm-shadow", "g-c", "member", 0),
      mapping("rm-eng", "g-a", "admin", 1),
    ];
  });

  it("reassigns 0..n-1, flips the list, and promotes the unshadowed", async () => {
    const res = await reorder(["rm-eng", "rm-shadow"]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as RoleMappingBody[];
    expect(body.map((r) => r.id)).toEqual(["rm-eng", "rm-shadow"]);
    expect(body.map((r) => r.priority)).toEqual([0, 1]);
    expect(roleOf(MEMBER)).toBe("admin");
    expect(mappingAudits()[0]).toMatchObject({
      action: "update",
      service: "role-mapping",
      source: "api",
      organizationId: ORG,
      metadata: { change: "order", count: 2, rolesChanged: 1 },
    });
  });

  it("409s a body that does not name every mapping exactly once", async () => {
    expect((await reorder(["rm-eng"])).status).toBe(409);
    expect((await reorder(["rm-eng", "rm-shadow", "rm-x"])).status).toBe(409);
    // Priorities untouched.
    expect(store.roleMappings.find((m) => m.id === "rm-eng")?.priority).toBe(1);
    expect(store.audits).toHaveLength(0);
  });

  it("422s duplicate ids (malformed, not stale)", async () => {
    const res = await reorder(["rm-eng", "rm-eng"]);
    expect(res.status).toBe(422);
    expect(store.audits).toHaveLength(0);
  });

  it("accepts [] for an org with no mappings", async () => {
    store.roleMappings = store.roleMappings.filter(
      (m) => m.organizationId !== ORG,
    );
    const res = await reorder([]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("submitting the identical settled order writes nothing", async () => {
    const before = store.roleMappings.map((m) => ({ ...m }));
    const res = await reorder(["rm-shadow", "rm-eng"]);
    expect(res.status).toBe(200);
    expect((await res.json()).length).toBe(2);
    // No update was issued (updatedAt is byte-identical) and no apply
    // transaction was opened.
    expect(store.roleMappings).toEqual(before);
    expect(store.txCount).toBe(0);
    expect(memberAudits()).toHaveLength(0);
  });
});

describe("POST /v1/org/role-mappings/preview", () => {
  it("counts the raises a new admin mapping would make", async () => {
    const res = await preview({ groupId: "g-a", role: "admin" });
    expect(res.status).toBe(200);
    // g-a is {OWNER, ADMIN, MEMBER}: the owner is skipped and ADMIN is the
    // caller, so only MEMBER is counted.
    expect(await res.json()).toEqual({ affectedCount: 1 });
  });

  it("returns 0 for a member mapping (its effect is shadowing, not demotion)", async () => {
    const res = await preview({ groupId: "g-a", role: "member" });
    expect(await res.json()).toEqual({ affectedCount: 0 });
  });

  it("previews an EXISTING mapping at its current priority, so a shadowed group reads 0", async () => {
    // g-c (Everyone → member) sits at priority 0; g-b's mapping is below it,
    // and both cover MEMBER2.
    store.roleMappings = [
      mapping("rm-shadow", "g-c", "member", 0),
      mapping("rm-1", "g-b", "member", 1),
    ];
    const shadowed = await preview({ groupId: "g-b", role: "admin" });
    // MEMBER2 is shadowed by g-c; SUSPENDED is only in g-b, so it still counts.
    expect(await shadowed.json()).toEqual({ affectedCount: 1 });
  });

  it("includes suspended members (their stored role is their reinstate shape)", async () => {
    const res = await preview({ groupId: "g-b", role: "admin" });
    expect(await res.json()).toEqual({ affectedCount: 2 });
  });

  it("writes nothing and audits nothing", async () => {
    const mappingsBefore = store.roleMappings.map((m) => ({ ...m }));
    const membersBefore = store.members.map((m) => ({ ...m }));
    const res = await preview({ groupId: "g-a", role: "admin" });
    expect(res.status).toBe(200);
    expect(store.roleMappings).toEqual(mappingsBefore);
    expect(store.members).toEqual(membersBefore);
    expect(store.audits).toHaveLength(0);
    expect(store.txCount).toBe(0);
  });

  it("404s a group of another organization (no existence oracle)", async () => {
    expect((await preview({ groupId: "g-x", role: "admin" })).status).toBe(404);
    expect((await preview({ groupId: "g-nope", role: "admin" })).status).toBe(
      404,
    );
  });

  it("422s role: owner", async () => {
    expect((await preview({ groupId: "g-a", role: "owner" })).status).toBe(422);
  });
});

describe("applying the mappings", () => {
  it("raises every non-owner, non-self member and audits one MEMBER row each", async () => {
    const res = await create({ groupId: "g-a", role: "admin" });
    expect(res.status).toBe(200);
    expect(roleOf(MEMBER)).toBe("admin");
    // Untouched: the owner (C1) and the acting admin (C2, already admin).
    expect(roleOf(OWNER)).toBe("owner");
    expect(roleOf(MEMBER2)).toBe("member");

    expect(memberAudits()).toHaveLength(1);
    expect(memberAudits()[0]).toMatchObject({
      organizationId: ORG,
      userId: ADMIN,
      userEmail: `${ADMIN}@example.com`,
      action: "update",
      service: "member",
      source: "api",
      metadata: {
        targetUserId: MEMBER,
        role: "admin",
        previousRole: "member",
        via: "role-mapping",
        groupId: "g-a",
        trigger: "mapping",
      },
    });
  });

  it("is idempotent: re-applying changes nothing and writes no extra audits", async () => {
    const first = await create({ groupId: "g-a", role: "admin" });
    expect(first.status).toBe(200);
    const created = (await first.json()) as RoleMappingBody;
    expect(memberAudits()).toHaveLength(1);

    store.txCount = 0;
    store.audits = [];
    const again = await update(created.id, { role: "admin" });
    expect(again.status).toBe(200);
    expect(memberAudits()).toHaveLength(0);
    // No apply transaction was opened at all.
    expect(store.txCount).toBe(0);
    expect(mappingAudits()[0]?.metadata).toMatchObject({ rolesChanged: 0 });
  });

  it("NEVER strips the last owner — create, reorder, or delete", async () => {
    const before = store.members.find((m) => m.userId === OWNER);
    expect(activeOwners()).toHaveLength(1);

    // The owner is a member of g-a; map it to the weakest role there is.
    const created = await create({ groupId: "g-a", role: "member" });
    expect(created.status).toBe(200);
    const id = ((await created.json()) as RoleMappingBody).id;
    expect(activeOwners()).toHaveLength(1);

    expect((await reorder([id, "rm-1"])).status).toBe(200);
    expect(activeOwners()).toHaveLength(1);

    expect((await remove(id)).status).toBe(200);
    expect(activeOwners()).toHaveLength(1);
    // The owner's row is byte-identical throughout.
    expect(store.members.find((m) => m.userId === OWNER)).toEqual(before);
  });

  it("never demotes: a hand-promoted admin in a member-mapped group keeps admin", async () => {
    const row = store.members.find((m) => m.userId === MEMBER2);
    if (row) row.role = "admin";
    const res = await create({ groupId: "g-c", role: "member" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ role: "member" });
    expect(roleOf(MEMBER2)).toBe("admin");
    expect(memberAudits()).toHaveLength(0);
  });

  // The other face of "a mapping is a FLOOR": a hand demotion is NOT a durable
  // undo while the mapping is still live. Pinned deliberately — the UI copy and
  // the roadmap's decision C both have to say so.
  it("re-raises a hand-demoted member who is still in an admin-mapped group", async () => {
    const created = await create({ groupId: "g-a", role: "admin" });
    expect(created.status).toBe(200);
    const id = ((await created.json()) as RoleMappingBody).id;
    expect(roleOf(MEMBER)).toBe("admin");

    // As `PATCH /v1/org/members/:userId` would: the admin demotes them by hand.
    const row = store.members.find((m) => m.userId === MEMBER);
    if (row) row.role = "member";
    store.audits = [];

    // ANY later apply — here a reorder — puts the role straight back, because
    // MEMBER is still a member of the still-mapped group.
    expect((await reorder([id, "rm-1"])).status).toBe(200);
    expect(roleOf(MEMBER)).toBe("admin");
    expect(memberAudits()).toHaveLength(1);
    expect(memberAudits()[0]).toMatchObject({
      metadata: { targetUserId: MEMBER, role: "admin", via: "role-mapping" },
    });

    // The durable remedy: drop the mapping FIRST, then demote.
    expect((await remove(id)).status).toBe(200);
    if (row) row.role = "member";
    expect((await reorder(["rm-1"])).status).toBe(200);
    expect(roleOf(MEMBER)).toBe("member");
  });

  it("raises a SUSPENDED member too (their stored role is their reinstate shape)", async () => {
    const res = await update("rm-1", { role: "admin" });
    expect(res.status).toBe(200);
    expect(roleOf(SUSPENDED)).toBe("admin");
    expect(store.members.find((m) => m.userId === SUSPENDED)?.status).toBe(
      "suspended",
    );
    expect(
      memberAudits()
        .map((a) => a.metadata.targetUserId)
        .sort(),
    ).toEqual([MEMBER2, SUSPENDED].sort());
  });

  it("keeps mapping audit metadata bounded — counts only, never id arrays", async () => {
    const res = await create({ groupId: "g-a", role: "admin" });
    expect(res.status).toBe(200);
    for (const audit of mappingAudits()) {
      expect(audit.organizationId).toBe(ORG);
      expect(audit.source).toBe("api");
      for (const value of Object.values(audit.metadata)) {
        expect(Array.isArray(value)).toBe(false);
      }
    }
  });

  it("never touches another organization's members", async () => {
    const res = await create({ groupId: "g-a", role: "admin" });
    expect(res.status).toBe(200);
    expect(
      store.members.find((m) => m.organizationId === OTHER_ORG)?.role,
    ).toBe("admin");
  });
});
