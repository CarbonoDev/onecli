import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@onecli/db";
import type { Hono } from "hono";
import type { ApiEnv } from "../../types";
import { MAX_PROJECTS_PER_ORG } from "../../validations/project";

// `/v1/projects` end-to-end through the real app: the OSS routes mounted on
// the `eeRoutes` seam, the OSS role resolver wired as the RoleResolver, and
// `CAPS.rbac` on. Same harness shape as groups.test.ts — cloned, not shared —
// except that `project_access` is a REAL table here rather than the
// `findFirst: async () => null` stub the org suites use: these rows are the
// authorization data three enforcement points read.
//
// Admin callers arrive with an org API key; the non-admin cases use a session,
// since a non-admin's org key fails key authentication outright.

const ORG = "org-1";
const OTHER_ORG = "org-2";
const OWNER = "user-owner";
const ADMIN = "user-admin";
const MEMBER = "user-member";
const MEMBER2 = "user-member2";
const OUTSIDER = "user-outsider";
/** A real User row with NO membership in either org (Decision J's filter). */
const STRANGER = "user-stranger";
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
  name: string | null;
  slug: string | null;
  createdByUserId: string | null;
  /** Denormalized creator email — outlives the `users` row it came from. */
  createdByUserEmail: string | null;
  createdAt: Date;
}

interface GroupRow {
  id: string;
  organizationId: string;
  name: string;
  source: string;
}

interface GroupMemberRow {
  groupId: string;
  userId: string;
}

interface AccessRow {
  id: string;
  projectId: string;
  userId: string | null;
  groupId: string | null;
  role: string;
  createdByUserId: string | null;
  createdAt: Date;
}

/**
 * Every project-child table this suite exercises shares this shape.
 * `projectId` is nullable because it genuinely is: an ORGANIZATION-scoped
 * secret or app connection carries none, and those rows must never be counted
 * against a project.
 */
interface ChildRow {
  id: string;
  projectId: string | null;
}

interface KeyRow extends ChildRow {
  key: string;
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

const store = vi.hoisted(() => ({
  users: [] as UserRow[],
  members: [] as MemberRow[],
  projects: [] as ProjectRow[],
  groups: [] as GroupRow[],
  groupMembers: [] as GroupMemberRow[],
  projectAccess: [] as AccessRow[],
  agents: [] as ChildRow[],
  apiKeys: [] as KeyRow[],
  secrets: [] as ChildRow[],
  appConnections: [] as ChildRow[],
  appConfigs: [] as ChildRow[],
  policyRules: [] as ChildRow[],
  policyRulesV2: [] as ChildRow[],
  vaultConnections: [] as ChildRow[],
  budgets: [] as ChildRow[],
  onboardingSurveys: [] as ChildRow[],
  audits: [] as AuditRow[],
  seq: 0,
  txCount: 0,
  /** Which user the session provider resolves to (null = no session). */
  sessionUserId: null as string | null,
}));

/** Gateway flushes are spied, never fetched: the DELETE path must hand the
 * keys it captured BEFORE the delete to invalidateGatewayCacheForKeys. */
const flushes = vi.hoisted(() => ({
  keys: [] as string[][],
  orgs: [] as string[],
  accounts: [] as string[],
}));

vi.mock("../../lib/gateway-invalidate", () => ({
  invalidateGatewayCache: () => {},
  invalidateGatewayCacheForKeys: (keys: string[]) => {
    flushes.keys.push(keys);
  },
  invalidateGatewayCacheForAccount: (projectId: string) => {
    flushes.accounts.push(projectId);
  },
  invalidateGatewayCacheForOrg: (organizationId: string) => {
    flushes.orgs.push(organizationId);
  },
}));

vi.mock("@onecli/db", () => {
  // ── where shapes these routes actually build ────────────────────────────
  interface StringFilter {
    not?: string | null;
    in?: string[];
  }
  interface BindingClause {
    userId?: string;
    group?: { members: { some: { userId: string } } };
  }
  interface ProjectWhere {
    id?: string | StringFilter;
    organizationId?: string;
    slug?: { startsWith: string };
    createdByUserId?: string;
    organization?: {
      members: { some: { userId: string; status?: { not?: string } } };
    };
    accessBindings?: { some: { OR: BindingClause[] } };
    OR?: ProjectWhere[];
  }
  interface ProjectCreateData {
    id: string;
    name?: string | null;
    slug?: string | null;
    organizationId: string;
    createdByUserId?: string | null;
    createdByUserEmail?: string | null;
    accessBindings?: { create: { userId: string; role: string } };
    apiKeys?: { create: { key: string } };
    agents?: { create: unknown };
  }
  interface AccessWhere {
    projectId?: string;
    userId?: string | StringFilter | null;
    groupId?: string | StringFilter | null;
    role?: string;
    user?: { organizationMemberships: { some: { organizationId: string } } };
    group?: { organizationId: string };
    OR?: BindingClause[];
  }

  const matchesString = (
    value: string | null,
    filter: string | StringFilter | null | undefined,
  ): boolean => {
    if (filter === undefined) return true;
    if (filter === null) return value === null;
    if (typeof filter === "string") return value === filter;
    if (filter.in !== undefined)
      return value !== null && filter.in.includes(value);
    if ("not" in filter) {
      if (filter.not === null) return value !== null;
      return value !== filter.not;
    }
    return true;
  };

  /** Does `projectId` carry a binding satisfying any of the OR clauses? */
  const matchesBindingClause = (projectId: string, clauses: BindingClause[]) =>
    clauses.some((clause) => {
      if (clause.userId !== undefined) {
        return store.projectAccess.some(
          (pa) => pa.projectId === projectId && pa.userId === clause.userId,
        );
      }
      const userId = clause.group?.members.some.userId;
      if (userId === undefined) return false;
      return store.projectAccess.some(
        (pa) =>
          pa.projectId === projectId &&
          pa.groupId !== null &&
          store.groupMembers.some(
            (gm) => gm.groupId === pa.groupId && gm.userId === userId,
          ),
      );
    });

  const matchesProject = (row: ProjectRow, where: ProjectWhere): boolean => {
    if (!matchesString(row.id, where.id)) return false;
    if (
      where.organizationId !== undefined &&
      row.organizationId !== where.organizationId
    )
      return false;
    if (
      where.createdByUserId !== undefined &&
      row.createdByUserId !== where.createdByUserId
    )
      return false;
    if (
      where.slug?.startsWith !== undefined &&
      !(row.slug ?? "").startsWith(where.slug.startsWith)
    )
      return false;
    if (where.organization) {
      const { userId, status } = where.organization.members.some;
      const membership = store.members.find(
        (m) => m.organizationId === row.organizationId && m.userId === userId,
      );
      if (!membership) return false;
      if (status?.not !== undefined && membership.status === status.not)
        return false;
    }
    if (
      where.accessBindings &&
      !matchesBindingClause(row.id, where.accessBindings.some.OR)
    )
      return false;
    if (where.OR && !where.OR.some((sub) => matchesProject(row, sub)))
      return false;
    return true;
  };

  const matchesAccess = (row: AccessRow, where: AccessWhere): boolean => {
    if (where.projectId !== undefined && row.projectId !== where.projectId)
      return false;
    if (!matchesString(row.userId, where.userId)) return false;
    if (!matchesString(row.groupId, where.groupId)) return false;
    if (where.role !== undefined && row.role !== where.role) return false;
    if (where.user) {
      const organizationId =
        where.user.organizationMemberships.some.organizationId;
      const isMember = store.members.some(
        (m) => m.userId === row.userId && m.organizationId === organizationId,
      );
      if (!isMember) return false;
    }
    if (where.group) {
      const group = store.groups.find((g) => g.id === row.groupId);
      if (!group || group.organizationId !== where.group.organizationId)
        return false;
    }
    if (where.OR && !matchesBindingClause(row.projectId, where.OR))
      return false;
    return true;
  };

  interface AccessSelect {
    id?: boolean;
    userId?: boolean;
    groupId?: boolean;
    role?: boolean;
    createdAt?: boolean;
    user?: { select: { email?: boolean; name?: boolean } };
    group?: {
      select: {
        name?: boolean;
        _count?: { select: { members?: boolean } };
        members?: { select: { userId?: boolean } };
      };
    };
  }

  const pickAccess = (row: AccessRow, select?: AccessSelect) => {
    if (!select) return { ...row };
    const picked: Record<string, unknown> = {};
    for (const key of [
      "id",
      "userId",
      "groupId",
      "role",
      "createdAt",
    ] as const) {
      if (select[key]) picked[key] = row[key];
    }
    if (select.user) {
      const user = store.users.find((u) => u.id === row.userId);
      picked.user = user
        ? { email: user.email, name: user.name }
        : { email: "", name: null };
    }
    if (select.group) {
      const group = store.groups.find((g) => g.id === row.groupId);
      const members = store.groupMembers.filter(
        (gm) => gm.groupId === row.groupId,
      );
      const value: Record<string, unknown> = {};
      if (select.group.select.name) value.name = group?.name ?? "";
      if (select.group.select._count)
        value._count = { members: members.length };
      if (select.group.select.members)
        value.members = members.map((m) => ({ userId: m.userId }));
      picked.group = group ? value : null;
    }
    return picked;
  };

  /** The two project projections: `projectSelect` and `projectRowSelect`. */
  interface ProjectSelect {
    id?: boolean;
    // Not part of any client row — the auth/session resolvers read it.
    organizationId?: boolean;
    name?: boolean;
    slug?: boolean;
    createdAt?: boolean;
    createdByUserId?: boolean;
    createdByUserEmail?: boolean;
  }

  /**
   * Project a project row. Scalars only — the owner is the stored
   * `createdByUserEmail` column, with no `users` join to model, and the counts
   * come from the `groupBy` on each child delegate rather than from here.
   */
  const pickProject = (row: ProjectRow, select?: ProjectSelect) => {
    if (!select) return { ...row };
    const picked: Record<string, unknown> = {};
    for (const key of [
      "id",
      "organizationId",
      "name",
      "slug",
      "createdAt",
      "createdByUserId",
      "createdByUserEmail",
    ] as const) {
      if (select[key]) picked[key] = row[key];
    }
    return picked;
  };

  /** Every `projects`-child table shares count/deleteMany, keyed by projectId. */
  const childDelegate = <T extends ChildRow>(
    read: () => T[],
    write: (rows: T[]) => void,
  ) => ({
    count: async ({ where }: { where: { projectId: string } }) =>
      read().filter((row) => row.projectId === where.projectId).length,
    /**
     * The grouped count `countsByProject` issues. Modelled faithfully in the
     * two ways that matter: a project owning none of this kind is ABSENT from
     * the result (never a zero row), and an org-scoped row (projectId null)
     * can never satisfy the `IN`, so it is invisible to every card.
     */
    groupBy: async ({
      where,
    }: {
      by: readonly ["projectId"];
      where: { projectId: { in: string[] } };
      _count: { _all: true };
    }) => {
      const wanted = new Set(where.projectId.in);
      const tally = new Map<string, number>();
      for (const row of read()) {
        if (row.projectId === null || !wanted.has(row.projectId)) continue;
        tally.set(row.projectId, (tally.get(row.projectId) ?? 0) + 1);
      }
      return [...tally].map(([projectId, n]) => ({
        projectId,
        _count: { _all: n },
      }));
    },
    deleteMany: async ({ where }: { where: { projectId: string } }) => {
      const before = read().length;
      write(read().filter((row) => row.projectId !== where.projectId));
      return { count: before - read().length };
    },
  });

  const delegates = {
    user: {
      findUnique: async ({
        where,
        select,
      }: {
        where: { id?: string; externalAuthId?: string };
        select?: Record<string, unknown>;
      }) => {
        const user = store.users.find(
          (u) =>
            (where.id !== undefined && u.id === where.id) ||
            (where.externalAuthId !== undefined &&
              u.externalAuthId === where.externalAuthId),
        );
        if (!user) return null;
        if (select?.organizationMemberships) {
          return {
            organizationMemberships: store.members
              .filter((m) => m.userId === user.id)
              .map((m) => ({ organizationId: m.organizationId })),
          };
        }
        return user;
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
        return (
          store.members.find(
            (m) => m.organizationId === organizationId && m.userId === userId,
          ) ?? null
        );
      },
      findFirst: async ({
        where,
      }: {
        where: {
          organizationId?: string;
          userId?: string;
          status?: string | { not?: string };
        };
      }) =>
        store.members
          .slice()
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .find(
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
      findMany: async ({
        where,
      }: {
        where: {
          organizationId?: string;
          userId?: { in: string[] };
          status?: { not?: string };
        };
      }) =>
        store.members
          .filter(
            (row) =>
              (where.organizationId === undefined ||
                row.organizationId === where.organizationId) &&
              (where.userId === undefined ||
                where.userId.in.includes(row.userId)) &&
              (where.status?.not === undefined ||
                row.status !== where.status.not),
          )
          .map((row) => ({ userId: row.userId })),
    },
    project: {
      findFirst: async ({
        where,
        select,
      }: {
        where: ProjectWhere;
        select?: ProjectSelect;
      }) => {
        const row = store.projects
          .slice()
          .sort(
            (a, b) =>
              a.createdAt.getTime() - b.createdAt.getTime() ||
              a.id.localeCompare(b.id),
          )
          .find((p) => matchesProject(p, where));
        return row ? pickProject(row, select) : null;
      },
      findUnique: async ({
        where,
        select,
      }: {
        where: { id: string };
        select?: ProjectSelect;
      }) => {
        const row = store.projects.find((p) => p.id === where.id);
        return row ? pickProject(row, select) : null;
      },
      findMany: async ({
        where,
        select,
      }: {
        where: ProjectWhere;
        select?: ProjectSelect;
        orderBy?: unknown;
      }) => {
        // Always `createdAt asc, id asc` — the only ordering `listProjects`
        // asks for, and the same one `findUserDefaultProject` uses.
        const rows = store.projects
          .slice()
          .sort(
            (a, b) =>
              a.createdAt.getTime() - b.createdAt.getTime() ||
              a.id.localeCompare(b.id),
          )
          .filter((p) => matchesProject(p, where));
        return rows.map((row) => pickProject(row, select));
      },
      // Mirrors the nested create `createProject` issues: the project row plus
      // its owner binding, api key and default agent land together, which is
      // exactly the atomicity Guard G depends on.
      create: async ({
        data,
        select,
      }: {
        data: ProjectCreateData;
        select?: ProjectSelect;
      }) => {
        if (
          store.projects.some(
            (p) =>
              p.organizationId === data.organizationId && p.slug === data.slug,
          )
        ) {
          // Prisma's @@unique([organizationId, slug]).
          throw Object.assign(new Error("Unique constraint failed"), {
            code: "P2002",
          });
        }
        const row: ProjectRow = {
          id: data.id,
          organizationId: data.organizationId,
          name: data.name ?? null,
          slug: data.slug ?? null,
          createdByUserId: data.createdByUserId ?? null,
          createdByUserEmail: data.createdByUserEmail ?? null,
          createdAt: new Date(),
        };
        store.projects.push(row);
        if (data.accessBindings?.create) {
          const b = data.accessBindings.create;
          store.projectAccess.push(
            access(
              `pa-new-${row.id}`,
              row.id,
              { userId: b.userId },
              b.role,
              row.createdAt,
            ),
          );
        }
        if (data.apiKeys?.create) {
          store.apiKeys.push({
            id: `k-new-${row.id}`,
            projectId: row.id,
            key: data.apiKeys.create.key,
          });
        }
        if (data.agents?.create) {
          store.agents.push({ id: `ag-new-${row.id}`, projectId: row.id });
        }
        // Projected AFTER the nested children land, so `_count` sees the
        // seeded agent — the same statement, the same snapshot, as Prisma.
        return pickProject(row, select);
      },
      count: async ({ where }: { where: ProjectWhere }) =>
        store.projects.filter((p) => matchesProject(p, where)).length,
      updateMany: async ({
        where,
        data,
      }: {
        where: ProjectWhere;
        data: { name?: string };
      }) => {
        const rows = store.projects.filter((p) => matchesProject(p, where));
        for (const row of rows) {
          if (data.name !== undefined) row.name = data.name;
        }
        return { count: rows.length };
      },
      deleteMany: async ({ where }: { where: ProjectWhere }) => {
        const rows = store.projects.filter((p) => matchesProject(p, where));
        // Widened so an ORG-scoped child (projectId null) can be tested
        // against it — it is never a member, so such rows always survive.
        const ids = new Set<string | null>(rows.map((r) => r.id));
        store.projects = store.projects.filter((p) => !ids.has(p.id));
        // The DB CASCADEs that ride the project row: project_access and
        // policy_rules_v2.
        store.projectAccess = store.projectAccess.filter(
          (pa) => !ids.has(pa.projectId),
        );
        store.policyRulesV2 = store.policyRulesV2.filter(
          (r) => !ids.has(r.projectId),
        );
        return { count: rows.length };
      },
    },
    projectAccess: {
      findFirst: async ({
        where,
        select,
      }: {
        where: AccessWhere;
        select?: AccessSelect;
      }) => {
        const row = store.projectAccess.find((pa) => matchesAccess(pa, where));
        return row ? pickAccess(row, select) : null;
      },
      findMany: async ({
        where,
        select,
        take,
      }: {
        where: AccessWhere;
        select?: AccessSelect;
        take?: number;
      }) => {
        const rows = store.projectAccess
          .filter((pa) => matchesAccess(pa, where))
          .sort(
            (a, b) =>
              a.createdAt.getTime() - b.createdAt.getTime() ||
              a.id.localeCompare(b.id),
          );
        const limited = take === undefined ? rows : rows.slice(0, take);
        return limited.map((row) => pickAccess(row, select));
      },
      count: async ({ where }: { where: AccessWhere }) =>
        store.projectAccess.filter((pa) => matchesAccess(pa, where)).length,
      updateMany: async ({
        where,
        data,
      }: {
        where: AccessWhere;
        data: { role: string };
      }) => {
        const rows = store.projectAccess.filter((pa) =>
          matchesAccess(pa, where),
        );
        for (const row of rows) row.role = data.role;
        return { count: rows.length };
      },
      deleteMany: async ({ where }: { where: AccessWhere }) => {
        const rows = store.projectAccess.filter((pa) =>
          matchesAccess(pa, where),
        );
        const ids = new Set(rows.map((r) => r.id));
        store.projectAccess = store.projectAccess.filter(
          (pa) => !ids.has(pa.id),
        );
        return { count: ids.size };
      },
      createMany: async ({
        data,
      }: {
        data: {
          projectId: string;
          userId?: string;
          groupId?: string;
          role: string;
          createdByUserId: string | null;
        }[];
        skipDuplicates?: boolean;
      }) => {
        let count = 0;
        for (const row of data) {
          const dupe = store.projectAccess.some(
            (pa) =>
              pa.projectId === row.projectId &&
              ((row.userId !== undefined && pa.userId === row.userId) ||
                (row.groupId !== undefined && pa.groupId === row.groupId)),
          );
          if (dupe) continue; // skipDuplicates
          store.projectAccess.push({
            id: `pa-${++store.seq}`,
            projectId: row.projectId,
            // Stored verbatim so the test can assert the exactly-one-of DB
            // CHECK the mock itself cannot enforce.
            userId: row.userId ?? null,
            groupId: row.groupId ?? null,
            role: row.role,
            createdByUserId: row.createdByUserId,
            createdAt: new Date(Date.UTC(2026, 1, 1, 0, store.seq)),
          });
          count++;
        }
        return { count };
      },
    },
    group: {
      findMany: async ({
        where,
      }: {
        where: { organizationId: string; id: { in: string[] } };
      }) =>
        store.groups
          .filter(
            (g) =>
              g.organizationId === where.organizationId &&
              where.id.in.includes(g.id),
          )
          .map((g) => ({ id: g.id })),
    },
    apiKey: {
      findUnique: async ({ where }: { where: { key?: string } }) => {
        if (where.key === ADMIN_KEY)
          return {
            userId: ADMIN,
            organizationId: ORG,
            scope: "organization",
          };
        // A PROJECT-scoped key owned by the org's OWNER: it authenticates
        // fine, which is exactly why the router needs its own scope guard.
        if (where.key === PROJECT_KEY)
          return { userId: OWNER, projectId: "proj-2" };
        return null;
      },
      findFirst: async () => null,
      findMany: async ({
        where,
      }: {
        where: { projectId?: string; project?: { organizationId: string } };
      }) =>
        store.apiKeys
          .filter(
            (row) =>
              where.projectId === undefined ||
              row.projectId === where.projectId,
          )
          .map((row) => ({ key: row.key })),
      ...childDelegate<KeyRow>(
        () => store.apiKeys,
        (rows) => {
          store.apiKeys = rows;
        },
      ),
    },
    agent: childDelegate<ChildRow>(
      () => store.agents,
      (rows) => {
        store.agents = rows;
      },
    ),
    secret: childDelegate<ChildRow>(
      () => store.secrets,
      (rows) => {
        store.secrets = rows;
      },
    ),
    appConnection: childDelegate<ChildRow>(
      () => store.appConnections,
      (rows) => {
        store.appConnections = rows;
      },
    ),
    appConfig: childDelegate<ChildRow>(
      () => store.appConfigs,
      (rows) => {
        store.appConfigs = rows;
      },
    ),
    policyRule: childDelegate<ChildRow>(
      () => store.policyRules,
      (rows) => {
        store.policyRules = rows;
      },
    ),
    policyRuleV2: childDelegate<ChildRow>(
      () => store.policyRulesV2,
      (rows) => {
        store.policyRulesV2 = rows;
      },
    ),
    vaultConnection: childDelegate<ChildRow>(
      () => store.vaultConnections,
      (rows) => {
        store.vaultConnections = rows;
      },
    ),
    budget: childDelegate<ChildRow>(
      () => store.budgets,
      (rows) => {
        store.budgets = rows;
      },
    ),
    onboardingSurvey: childDelegate<ChildRow>(
      () => store.onboardingSurveys,
      (rows) => {
        store.onboardingSurveys = rows;
      },
    ),
    auditLog: {
      create: async ({ data }: { data: AuditRow }) => {
        store.audits.push(data);
        return data;
      },
    },
  };

  return {
    Prisma: { JsonNull: null },
    db: {
      ...delegates,
      // Both forms: the access replace-set uses the array form, the delete
      // cascade the interactive (callback) form.
      $transaction: async (arg: unknown) => {
        store.txCount++;
        if (typeof arg === "function") {
          return (arg as (tx: typeof delegates) => Promise<unknown>)(delegates);
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
  createdAt,
});

const access = (
  id: string,
  projectId: string,
  principal: { userId?: string; groupId?: string },
  role: string,
  createdAt: Date,
): AccessRow => ({
  id,
  projectId,
  userId: principal.userId ?? null,
  groupId: principal.groupId ?? null,
  role,
  createdByUserId: null,
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
      email: "member@example.com",
      name: null,
    },
    {
      id: MEMBER2,
      externalAuthId: "ext-member2",
      email: "member2@example.com",
      name: "Mia Member",
    },
    {
      id: OUTSIDER,
      externalAuthId: "ext-outsider",
      email: "outsider@other.test",
      name: "Odette Outsider",
    },
    {
      id: STRANGER,
      externalAuthId: "ext-stranger",
      email: "stranger@nowhere.test",
      name: "Sam Stranger",
    },
  ];
  store.members = [
    member(OWNER, "owner", at(0)),
    member(ADMIN, "admin", at(1)),
    member(MEMBER, "member", at(2)),
    member(MEMBER2, "member", at(3)),
    member(OUTSIDER, "admin", at(4), OTHER_ORG),
  ];
  store.projects = [
    {
      id: "proj-1",
      organizationId: ORG,
      name: "Alpha",
      slug: "alpha",
      createdByUserId: MEMBER,
      createdByUserEmail: "member@example.com",
      createdAt: at(0),
    },
    {
      id: "proj-2",
      organizationId: ORG,
      name: "Beta",
      slug: "beta",
      createdByUserId: OWNER,
      createdByUserEmail: "owner@example.com",
      createdAt: at(1),
    },
    {
      id: "proj-3",
      organizationId: ORG,
      name: "Gamma",
      slug: "gamma",
      createdByUserId: ADMIN,
      createdByUserEmail: "admin@example.com",
      createdAt: at(2),
    },
    // No bindings at all — the legacy zero-binding shape (L5).
    {
      id: "proj-4",
      organizationId: ORG,
      name: "Delta",
      slug: "delta",
      createdByUserId: OWNER,
      createdByUserEmail: "owner@example.com",
      createdAt: at(3),
    },
    {
      id: "proj-x",
      organizationId: OTHER_ORG,
      name: "Foreign",
      slug: "foreign",
      createdByUserId: OUTSIDER,
      createdByUserEmail: "outsider@other.test",
      createdAt: at(4),
    },
  ];
  store.groups = [
    { id: "g-a", organizationId: ORG, name: "Engineering", source: "manual" },
    { id: "g-scim", organizationId: ORG, name: "Provisioned", source: "scim" },
    { id: "g-x", organizationId: OTHER_ORG, name: "Foreign", source: "manual" },
  ];
  store.groupMembers = [
    { groupId: "g-a", userId: MEMBER2 },
    { groupId: "g-x", userId: OUTSIDER },
  ];
  store.projectAccess = [
    access("pa-1", "proj-1", { userId: MEMBER }, "owner", at(10)),
    // A GROUP row carrying role "owner" on purpose: group bindings must never
    // confer management, whatever the column says.
    access("pa-2", "proj-1", { groupId: "g-a" }, "owner", at(11)),
    access("pa-3", "proj-1", { userId: ADMIN }, "member", at(12)),
    access("pa-4", "proj-2", { userId: OWNER }, "owner", at(13)),
    access("pa-5", "proj-2", { userId: MEMBER2 }, "member", at(14)),
    access("pa-6", "proj-3", { userId: ADMIN }, "owner", at(15)),
    // Inert rows, filtered out of GET /access (Decision J + the org fence).
    access("pa-7", "proj-3", { userId: STRANGER }, "member", at(16)),
    access("pa-8", "proj-3", { groupId: "g-x" }, "member", at(17)),
    access("pa-9", "proj-x", { userId: OUTSIDER }, "owner", at(18)),
  ];
  store.agents = [
    { id: "ag-1", projectId: "proj-1" },
    { id: "ag-2", projectId: "proj-1" },
    { id: "ag-3", projectId: "proj-2" },
  ];
  store.apiKeys = [
    { id: "k-1", projectId: "proj-1", key: "oc_key-1" },
    { id: "k-2", projectId: "proj-1", key: "oc_key-2" },
    { id: "k-3", projectId: "proj-2", key: "oc_key-3" },
  ];
  store.secrets = [
    { id: "s-1", projectId: "proj-1" },
    { id: "s-2", projectId: "proj-2" },
  ];
  store.appConnections = [{ id: "ac-1", projectId: "proj-1" }];
  store.appConfigs = [{ id: "cfg-1", projectId: "proj-1" }];
  store.policyRules = [{ id: "pr-1", projectId: "proj-1" }];
  store.policyRulesV2 = [{ id: "pv-1", projectId: "proj-1" }];
  store.vaultConnections = [{ id: "vc-1", projectId: "proj-1" }];
  store.budgets = [{ id: "b-1", projectId: "proj-1" }];
  store.onboardingSurveys = [{ id: "os-1", projectId: "proj-1" }];
  store.audits = [];
  store.seq = 100;
  store.txCount = 0;
  store.sessionUserId = null;
  flushes.keys = [];
  flushes.orgs = [];
  flushes.accounts = [];
});

const asAdmin = { headers: { Authorization: `Bearer ${ADMIN_KEY}` } };
const asProjectKey = { headers: { Authorization: `Bearer ${PROJECT_KEY}` } };

const projectRow = (id: string) => store.projects.find((p) => p.id === id);
const bindings = (projectId: string) =>
  store.projectAccess.filter((pa) => pa.projectId === projectId);
const userBinding = (projectId: string, userId: string) =>
  bindings(projectId).find((pa) => pa.userId === userId);

interface ProjectBody {
  id: string;
  name: string | null;
  slug: string | null;
  createdAt: string;
  agentCount: number;
  resourceCount: number;
  ownerEmail: string | null;
}

interface AccessBody {
  users: {
    id: string;
    userId: string;
    name: string | null;
    email: string;
    role: string;
    isOwner: boolean;
    createdAt: string;
  }[];
  groups: {
    id: string;
    groupId: string;
    name: string;
    memberCount: number;
    createdAt: string;
  }[];
}

const get = (id: string, init: RequestInit = asAdmin) =>
  app.request(`/v1/projects/${id}`, init);

const list = (init: RequestInit = asAdmin) => app.request("/v1/projects", init);

/** Ids from a `GET /v1/projects` body, in response order. */
const listIds = async (init: RequestInit = asAdmin): Promise<string[]> => {
  const res = await list(init);
  expect(res.status).toBe(200);
  return ((await res.json()) as ProjectBody[]).map((p) => p.id);
};

const patch = (id: string, body: unknown, init: RequestInit = asAdmin) =>
  app.request(`/v1/projects/${id}`, {
    ...init,
    method: "PATCH",
    body: JSON.stringify(body),
  });

const remove = (id: string, init: RequestInit = asAdmin) =>
  app.request(`/v1/projects/${id}`, { ...init, method: "DELETE" });

const getAccess = (id: string, init: RequestInit = asAdmin) =>
  app.request(`/v1/projects/${id}/access`, init);

const putAccess = (id: string, body: unknown, init: RequestInit = asAdmin) =>
  app.request(`/v1/projects/${id}/access`, {
    ...init,
    method: "PUT",
    body: JSON.stringify(body),
  });

describe("GET /projects (list)", () => {
  it("401s an unauthenticated caller", async () => {
    expect((await list({})).status).toBe(401);
  });

  it("403s a project-scoped key — an agent credential must not enumerate projects", async () => {
    expect((await list(asProjectKey)).status).toBe(403);
  });

  it("returns every project in the org to an admin, oldest first", async () => {
    expect(await listIds()).toEqual(["proj-1", "proj-2", "proj-3", "proj-4"]);
  });

  it("never leaks another organization's projects", async () => {
    expect(await listIds()).not.toContain("proj-x");
    store.sessionUserId = OUTSIDER; // admin of OTHER_ORG only
    expect(await listIds({})).toEqual(["proj-x"]);
  });

  it("returns the whole org to an OWNER, not just their bindings", async () => {
    // OWNER holds one binding (proj-2) but is org owner — the admin arm wins,
    // so a project they hold no binding on (proj-4) must still be listed.
    store.sessionUserId = OWNER;
    expect(await listIds({})).toEqual(["proj-1", "proj-2", "proj-3", "proj-4"]);
  });

  it("returns ONLY bound projects to a plain member", async () => {
    store.sessionUserId = MEMBER; // owner binding on proj-1 only
    expect(await listIds({})).toEqual(["proj-1"]);
  });

  it("counts a GROUP binding, not just a direct one", async () => {
    // MEMBER2: direct `member` row on proj-2, plus proj-1 through group g-a.
    // Ordering is by createdAt, so the group-derived project comes first.
    store.sessionUserId = MEMBER2;
    expect(await listIds({})).toEqual(["proj-1", "proj-2"]);
  });

  it("omits a project with no bindings from a member's list", async () => {
    // proj-4 is the legacy zero-binding shape: visible to admins, unreachable
    // for a plain member, so it must not appear.
    store.sessionUserId = MEMBER;
    expect(await listIds({})).not.toContain("proj-4");
  });

  it("401s a SUSPENDED member before the handler runs, binding notwithstanding", async () => {
    // The suspension invariant, enforced a layer earlier than you might
    // expect: session auth resolves the default project through
    // `activeMembershipWhere`, which a suspended member fails, so no project
    // AND no org resolve and the request 401s. MEMBER's owner binding on
    // proj-1 never gets a chance to rescue them.
    //
    // `listProjects`'s own `if (!role) return []` arm is therefore
    // defence-in-depth for direct service callers, not a path this route can
    // reach — it exists so the function mirrors `canAccessProjectAsUser` arm
    // for arm rather than relying on its caller to have gated first.
    const row = store.members.find((m) => m.userId === MEMBER);
    if (row) row.status = "suspended";
    store.sessionUserId = MEMBER;
    expect((await list({})).status).toBe(401);
  });

  it("401s a non-member holding a stale binding", async () => {
    // STRANGER has a real ProjectAccess row on proj-3 but no membership at
    // all, so nothing resolves and auth rejects — the binding is inert.
    store.sessionUserId = STRANGER;
    expect((await list({})).status).toBe(401);
  });

  it("returns [] — not 403 — for a member with no bindings at all", async () => {
    // There is no id to authorize against, so an empty list IS the answer.
    store.projectAccess = store.projectAccess.filter(
      (pa) => pa.userId !== MEMBER,
    );
    store.sessionUserId = MEMBER;
    const res = await list({});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns the client Project shape and leaks no internal columns", async () => {
    const res = await list();
    const [first] = (await res.json()) as ProjectBody[];
    expect(first).toEqual({
      id: "proj-1",
      name: "Alpha",
      slug: "alpha",
      createdAt: expect.any(String),
      // 2 agents; 1 secret + 1 app connection = 2 resources.
      agentCount: 2,
      resourceCount: 2,
      ownerEmail: "member@example.com",
    });
    // `projectSelect` still reads `createdByUserId` (resolveAuthority needs
    // it) and `projectRowSelect` reads the raw email column; `toProjectRow`
    // must rename the one and drop the other, and the org id must not leak.
    for (const leaked of [
      "createdByUserId",
      "createdByUserEmail",
      "organizationId",
    ]) {
      expect(Object.keys(first ?? {})).not.toContain(leaked);
    }
  });

  it("counts only a project's OWN resources, never the org-scoped ones", async () => {
    // The whole reason this does not reuse `getResourceCounts`: an
    // organization-scoped secret/connection (projectId null) is visible from
    // every project, so folding it in would bump every card by the same
    // amount and make the grid useless for comparison.
    store.secrets.push({ id: "s-org", projectId: null });
    store.appConnections.push({ id: "ac-org", projectId: null });
    const rows = (await (await list()).json()) as ProjectBody[];
    expect(rows.map((p) => [p.id, p.agentCount, p.resourceCount])).toEqual([
      ["proj-1", 2, 2],
      ["proj-2", 1, 1],
      // Zero-count projects report 0, not null and not a missing key.
      ["proj-3", 0, 0],
      ["proj-4", 0, 0],
    ]);
  });

  it("keeps the owner email once the creator is DELETED", async () => {
    // Why the card reads the denormalized column instead of joining `users`.
    // `created_by_user_id` is `ON DELETE SET NULL`, so deleting the creator
    // takes the id and the joinable row with it; `created_by_user_email`
    // stays, and the owner line survives with no special case.
    store.users = store.users.filter((u) => u.id !== OWNER);
    const row = projectRow("proj-2");
    if (row) row.createdByUserId = null; // the FK's SET NULL

    const [, beta] = (await (await list()).json()) as ProjectBody[];
    expect(beta?.ownerEmail).toBe("owner@example.com");
  });

  it("reports a null owner for a project that records no creator at all", async () => {
    // Nothing to attribute the card to, so the client renders no owner line
    // rather than an empty one.
    const row = projectRow("proj-4");
    if (row) row.createdByUserEmail = null;
    const rows = (await (await list()).json()) as ProjectBody[];
    expect(rows.find((p) => p.id === "proj-4")?.ownerEmail).toBeNull();
  });

  it("reports the STORED email, not the creator's current one", async () => {
    // Provenance, not live identity: this is a column on the project row, so
    // a later email change does not rewrite history on the card.
    const user = store.users.find((u) => u.id === MEMBER);
    if (user) user.email = "renamed@example.com";
    const [first] = (await (await list()).json()) as ProjectBody[];
    expect(first?.ownerEmail).toBe("member@example.com");
  });

  it("costs the same number of reads for 4 projects as for 24", async () => {
    // The N+1 guard, written so it CAN fail: it compares two different list
    // sizes rather than asserting a constant the current source trivially
    // satisfies. A per-project count loop passes the 4-project case and fails
    // the 24-project one.
    //
    // Scope note: this pins the shape of the code (grouped counts, not a
    // loop), which is all a hand-rolled db mock can honestly witness — it
    // issues no SQL. That the grouped counts are also index-scoped in
    // Postgres was verified separately with EXPLAIN; see `countsByProject`.
    const reads = async () => {
      const spies = [
        vi.spyOn(db.project, "findMany"),
        vi.spyOn(db.agent, "groupBy"),
        vi.spyOn(db.secret, "groupBy"),
        vi.spyOn(db.appConnection, "groupBy"),
        vi.spyOn(db.agent, "count"),
        vi.spyOn(db.secret, "count"),
        vi.spyOn(db.appConnection, "count"),
      ];
      await list();
      const total = spies.reduce((n, spy) => n + spy.mock.calls.length, 0);
      for (const spy of spies) spy.mockRestore();
      return total;
    };

    const forFour = await reads();

    for (let n = 0; n < 20; n++) {
      store.projects.push({
        id: `many-${n}`,
        organizationId: ORG,
        name: `Many ${n}`,
        slug: `many-${n}`,
        createdByUserId: ADMIN,
        createdByUserEmail: "admin@example.com",
        createdAt: at(200 + n),
      });
      store.agents.push({ id: `ag-many-${n}`, projectId: `many-${n}` });
    }

    expect(await listIds()).toHaveLength(24);
    // 1 list + 3 grouped counts, at both sizes.
    expect(forFour).toBe(4);
    expect(await reads()).toBe(forFour);
  });

  it("agrees with GET /:projectId — everything listed is readable, and vice versa", async () => {
    // The invariant `listProjects` exists to hold: it must mirror
    // `canAccessProjectAsUser` arm for arm. Drift either way is a bug.
    store.sessionUserId = MEMBER2;
    const listed = new Set(await listIds({}));
    for (const id of ["proj-1", "proj-2", "proj-3", "proj-4"]) {
      const readable = (await get(id, {})).status === 200;
      expect(listed.has(id)).toBe(readable);
    }
  });

  it("reads nothing and audits nothing", async () => {
    await list();
    expect(store.audits).toHaveLength(0);
  });
});

describe("POST /projects (create)", () => {
  const create = (body: unknown, init: RequestInit = asAdmin) =>
    app.request("/v1/projects", {
      ...init,
      method: "POST",
      body: JSON.stringify(body),
    });

  it("401s an unauthenticated caller and 403s a project-scoped key", async () => {
    expect((await create({ name: "New" }, {})).status).toBe(401);
    expect((await create({ name: "New" }, asProjectKey)).status).toBe(403);
    expect(store.projects).toHaveLength(5);
    expect(store.audits).toHaveLength(0);
  });

  it("creates the project and seeds the caller as OWNER in the same write", async () => {
    // Guard G's precondition: a project that exists without an owner binding
    // can never be managed by anyone but an org admin.
    store.sessionUserId = MEMBER;
    const res = await create({ name: "Fresh Start" }, {});
    expect(res.status).toBe(201);
    const body = (await res.json()) as ProjectBody;

    const row = projectRow(body.id);
    expect(row?.organizationId).toBe(ORG);
    expect(row?.createdByUserId).toBe(MEMBER);
    expect(userBinding(body.id, MEMBER)?.role).toBe("owner");
  });

  it("returns the same shape the list does — counts and owner, on the create", async () => {
    // All four project endpoints share one `ProjectRow`, so the web's single
    // `Project` type does not have to hedge. A fresh project has its seeded
    // default agent and nothing else, and its creator is the caller.
    store.sessionUserId = MEMBER;
    const body = (await (
      await create({ name: "Shaped" }, {})
    ).json()) as ProjectBody;
    expect(body.agentCount).toBe(1); // the default agent, seeded in the same write
    expect(body.resourceCount).toBe(0);
    expect(body.ownerEmail).toBe("member@example.com");
  });

  it("makes the new project immediately manageable by its creator", async () => {
    // The end-to-end point of the owner seed: a plain member creates a project
    // and can then rename it, with no admin involvement.
    store.sessionUserId = MEMBER;
    const body = (await (
      await create({ name: "Mine" }, {})
    ).json()) as ProjectBody;
    expect((await patch(body.id, { name: "Renamed" }, {})).status).toBe(200);
    expect(projectRow(body.id)?.name).toBe("Renamed");
  });

  it("makes the new project appear in the creator's list", async () => {
    store.sessionUserId = MEMBER;
    const body = (await (
      await create({ name: "Listed" }, {})
    ).json()) as ProjectBody;
    expect(await listIds({})).toContain(body.id);
  });

  it("derives a slug from the name", async () => {
    const body = (await (
      await create({ name: "My New Project" })
    ).json()) as ProjectBody;
    expect(projectRow(body.id)?.slug).toBe("my-new-project");
  });

  it("disambiguates a colliding slug instead of failing — names are not unique", async () => {
    // `projectNameSchema` deliberately allows duplicate names, so two projects
    // called "Alpha" must both be creatable; only the slug has to differ.
    const first = (await (
      await create({ name: "Alpha" })
    ).json()) as ProjectBody;
    const second = (await (
      await create({ name: "Alpha" })
    ).json()) as ProjectBody;
    // "alpha" is already taken by the seeded proj-1.
    expect(projectRow(first.id)?.slug).toBe("alpha-2");
    expect(projectRow(second.id)?.slug).toBe("alpha-3");
    expect(projectRow(first.id)?.name).toBe("Alpha");
  });

  it("falls back to a usable slug when the name has no slug characters", async () => {
    const body = (await (await create({ name: "!!!" })).json()) as ProjectBody;
    expect(projectRow(body.id)?.slug).toBe("project");
  });

  it("422s an empty or missing name and writes nothing", async () => {
    expect((await create({ name: "" })).status).toBe(422);
    expect((await create({})).status).toBe(422);
    expect((await create({ name: "x".repeat(101) })).status).toBe(422);
    expect(store.projects).toHaveLength(5);
    expect(store.audits).toHaveLength(0);
  });

  it("401s a caller with no active membership, and writes nothing", async () => {
    // Rejected a layer earlier than `createProject`'s own gate: an org key
    // whose user has lost their membership fails key authentication outright
    // (the org-key branch re-checks role >= admin on every request), and a
    // suspended session resolves neither project nor org. So the service's
    // `if (!role) throw FORBIDDEN` is defence-in-depth for direct callers
    // rather than a path this route reaches — kept so the service is correct
    // on its own terms, not because the route depends on it.
    store.members = store.members.filter((m) => m.userId !== ADMIN);
    const res = await create({ name: "Nope" });
    expect(res.status).toBe(401);
    expect(store.projects).toHaveLength(5);
    expect(store.audits).toHaveLength(0);
  });

  it("409s at the per-org cap, counting only this org", async () => {
    // Fill ORG to the ceiling; OTHER_ORG's project must not count toward it.
    for (let n = store.projects.length; n < MAX_PROJECTS_PER_ORG + 1; n++) {
      store.projects.push({
        id: `bulk-${n}`,
        organizationId: ORG,
        name: `Bulk ${n}`,
        slug: `bulk-${n}`,
        createdByUserId: ADMIN,
        createdByUserEmail: "admin@example.com",
        createdAt: at(100 + n),
      });
    }
    const res = await create({ name: "One Too Many" });
    expect(res.status).toBe(409);
  });

  it("audits the create with the new project's id and name", async () => {
    const body = (await (
      await create({ name: "Audited" })
    ).json()) as ProjectBody;
    const row = store.audits.at(-1);
    expect(row?.action).toBe("create");
    expect(row?.projectId).toBe(body.id);
    expect(row?.organizationId).toBe(ORG);
    expect(row?.metadata).toMatchObject({
      projectId: body.id,
      name: "Audited",
    });
  });

  it("flushes the gateway org cache — ProjectAccess is authorization data", async () => {
    await create({ name: "Flushed" });
    expect(flushes.orgs).toContain(ORG);
  });
});

describe("guard stack", () => {
  it("401s an unauthenticated caller on every route", async () => {
    expect((await get("proj-1", {})).status).toBe(401);
    expect((await patch("proj-1", { name: "X" }, {})).status).toBe(401);
    expect((await remove("proj-1", {})).status).toBe(401);
    expect((await getAccess("proj-1", {})).status).toBe(401);
    expect(
      (await putAccess("proj-1", { users: [], groupIds: [] }, {})).status,
    ).toBe(401);
    expect(store.audits).toHaveLength(0);
  });

  it("403s a project-scoped key on every route, even when its user is an org owner", async () => {
    expect((await get("proj-2", asProjectKey)).status).toBe(403);
    expect((await patch("proj-2", { name: "X" }, asProjectKey)).status).toBe(
      403,
    );
    expect((await remove("proj-2", asProjectKey)).status).toBe(403);
    expect((await getAccess("proj-2", asProjectKey)).status).toBe(403);
    expect(
      (
        await putAccess(
          "proj-2",
          { users: [{ userId: OWNER, role: "owner" }], groupIds: [] },
          asProjectKey,
        )
      ).status,
    ).toBe(403);
    expect(projectRow("proj-2")?.name).toBe("Beta");
    expect(store.audits).toHaveLength(0);
  });

  it("200s a NON-ADMIN member holding an owner binding (the point of this stack)", async () => {
    store.sessionUserId = MEMBER;
    const res = await patch("proj-1", { name: "Renamed" }, {});
    expect(res.status).toBe(200);
    expect(projectRow("proj-1")?.name).toBe("Renamed");
  });

  it("403s an active member whose binding is a plain use grant", async () => {
    store.sessionUserId = MEMBER2; // `member` binding on proj-2
    const res = await patch("proj-2", { name: "Nope" }, {});
    expect(res.status).toBe(403);
    expect(projectRow("proj-2")?.name).toBe("Beta");
    expect(store.audits).toHaveLength(0);
  });

  it("403s a member whose only binding is a GROUP row, even at role owner", async () => {
    store.sessionUserId = MEMBER2; // in g-a, which is bound to proj-1 as "owner"
    const res = await patch("proj-1", { name: "Nope" }, {});
    expect(res.status).toBe(403);
    expect(projectRow("proj-1")?.name).toBe("Alpha");
  });

  it("rejects a suspended admin's org key (suspended reads as no role)", async () => {
    const row = store.members.find((m) => m.userId === ADMIN);
    if (row) row.status = "suspended";
    // The key path fails first, so this is a 401 rather than the 403 a
    // suspended session would get — either way the stale binding on proj-3
    // never rescues them.
    expect((await patch("proj-3", { name: "X" })).status).toBe(401);
    expect(projectRow("proj-3")?.name).toBe("Gamma");
  });

  it("rejects a suspended owner-binding holder's session", async () => {
    const row = store.members.find((m) => m.userId === MEMBER);
    if (row) row.status = "suspended";
    store.sessionUserId = MEMBER;
    expect((await patch("proj-1", { name: "X" }, {})).status).toBe(401);
    expect(projectRow("proj-1")?.name).toBe("Alpha");
  });
});

describe("GET /v1/projects/:projectId", () => {
  it("returns the project row with createdAt as an ISO string", async () => {
    const res = await get("proj-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "proj-1",
      name: "Alpha",
      slug: "alpha",
      createdAt: at(0).toISOString(),
      agentCount: 2,
      resourceCount: 2,
      ownerEmail: "member@example.com",
    });
  });

  it("404s a project of another organization and an unknown id", async () => {
    expect((await get("proj-x")).status).toBe(404);
    expect((await get("proj-nope")).status).toBe(404);
  });

  it("200s a plain member holding a use-only binding", async () => {
    store.sessionUserId = MEMBER2; // group binding on proj-1
    const res = await get("proj-1", {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as ProjectBody).id).toBe("proj-1");
  });

  it("200s an org admin with no binding at all", async () => {
    const res = await get("proj-4"); // zero bindings
    expect(res.status).toBe(200);
  });

  it("403s an active member with no binding on the project", async () => {
    store.sessionUserId = MEMBER2;
    expect((await get("proj-3", {})).status).toBe(403);
  });

  it("never audits a read", async () => {
    await get("proj-1");
    expect(store.audits).toHaveLength(0);
  });
});

describe("PATCH /v1/projects/:projectId", () => {
  it("renames, returns the row, and audits with organizationId AND projectId", async () => {
    const res = await patch("proj-1", { name: "Alpha Prime" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: "proj-1",
      name: "Alpha Prime",
      slug: "alpha",
    });
    expect(projectRow("proj-1")?.name).toBe("Alpha Prime");
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({
      organizationId: ORG,
      projectId: "proj-1",
      userId: ADMIN,
      action: "update",
      service: "project",
      source: "api",
      metadata: { projectId: "proj-1", change: "name", name: "Alpha Prime" },
    });
  });

  it("trims the name before storing", async () => {
    const res = await patch("proj-1", { name: "  Padded  " });
    expect(res.status).toBe(200);
    expect(projectRow("proj-1")?.name).toBe("Padded");
  });

  it("422s an empty / whitespace-only / overlong / missing name", async () => {
    for (const body of [
      { name: "" },
      { name: "   " },
      { name: "x".repeat(101) },
      {},
    ]) {
      expect((await patch("proj-1", body)).status).toBe(422);
    }
    expect(projectRow("proj-1")?.name).toBe("Alpha");
    expect(store.audits).toHaveLength(0);
  });

  it("422s an unparseable body rather than 500ing", async () => {
    const res = await app.request("/v1/projects/proj-1", {
      ...asAdmin,
      method: "PATCH",
    });
    expect(res.status).toBe(422);
  });

  it("permits a rename-to-self as a 200 no-op", async () => {
    const res = await patch("proj-1", { name: "Alpha" });
    expect(res.status).toBe(200);
    expect(projectRow("proj-1")?.name).toBe("Alpha");
  });

  it("lets two projects in the same org share a name (the 'Default' reality)", async () => {
    const res = await patch("proj-2", { name: "Alpha" });
    expect(res.status).toBe(200);
    expect(projectRow("proj-1")?.name).toBe("Alpha");
    expect(projectRow("proj-2")?.name).toBe("Alpha");
  });

  it("never writes slug", async () => {
    await patch("proj-1", { name: "Alpha Prime", slug: "hijacked" });
    expect(projectRow("proj-1")?.slug).toBe("alpha");
  });

  it("404s a project of another organization and audits nothing", async () => {
    const res = await patch("proj-x", { name: "Captured" });
    expect(res.status).toBe(404);
    expect(projectRow("proj-x")?.name).toBe("Foreign");
    expect(store.audits).toHaveLength(0);
  });

  it("403s a non-manager and writes/audits nothing", async () => {
    store.sessionUserId = MEMBER2;
    const res = await patch("proj-2", { name: "Nope" }, {});
    expect(res.status).toBe(403);
    expect(projectRow("proj-2")?.name).toBe("Beta");
    expect(store.audits).toHaveLength(0);
  });
});

describe("GET /v1/projects/:projectId/access", () => {
  it("returns users and groups in the client's exact shape, createdAt asc", async () => {
    const res = await getAccess("proj-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as AccessBody;
    expect(body.users).toEqual([
      {
        id: "pa-1",
        userId: MEMBER,
        name: null,
        email: "member@example.com",
        role: "owner",
        isOwner: true,
        createdAt: at(10).toISOString(),
      },
      {
        id: "pa-3",
        userId: ADMIN,
        name: "Adam Admin",
        email: "admin@example.com",
        role: "member",
        isOwner: false,
        createdAt: at(12).toISOString(),
      },
    ]);
    expect(body.groups).toEqual([
      {
        id: "pa-2",
        groupId: "g-a",
        name: "Engineering",
        memberCount: 1,
        createdAt: at(11).toISOString(),
      },
    ]);
  });

  it("normalizes a garbage role string to member instead of casting it", async () => {
    const row = store.projectAccess.find((pa) => pa.id === "pa-3");
    if (row) row.role = "superuser";
    const body = (await (await getAccess("proj-1")).json()) as AccessBody;
    expect(body.users.find((u) => u.userId === ADMIN)?.role).toBe("member");
  });

  it("keeps isOwner as creator provenance, independent of the management role", async () => {
    // Creator demoted, a non-creator promoted: the badge follows creation.
    const creatorRow = store.projectAccess.find((pa) => pa.id === "pa-1");
    if (creatorRow) creatorRow.role = "member";
    const otherRow = store.projectAccess.find((pa) => pa.id === "pa-3");
    if (otherRow) otherRow.role = "owner";

    const body = (await (await getAccess("proj-1")).json()) as AccessBody;
    expect(body.users.find((u) => u.userId === MEMBER)).toMatchObject({
      role: "member",
      isOwner: true,
    });
    expect(body.users.find((u) => u.userId === ADMIN)).toMatchObject({
      role: "owner",
      isOwner: false,
    });
  });

  it("excludes a user who is not a member of the org, and a group of another org", async () => {
    const body = (await (await getAccess("proj-3")).json()) as AccessBody;
    expect(body.users.map((u) => u.userId)).toEqual([ADMIN]);
    expect(body.groups).toEqual([]);
  });

  it("includes a SUSPENDED member's row (suspension is an auth-time gate)", async () => {
    const row = store.members.find((m) => m.userId === ADMIN);
    if (row) row.status = "suspended";
    store.sessionUserId = MEMBER; // the suspended admin can no longer call in
    const body = (await (await getAccess("proj-1", {})).json()) as AccessBody;
    expect(body.users.map((u) => u.userId)).toEqual([MEMBER, ADMIN]);
  });

  it("returns empty arrays for a project with no bindings, not a 404", async () => {
    const res = await getAccess("proj-4");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ users: [], groups: [] });
  });

  it("404s a project of another organization", async () => {
    expect((await getAccess("proj-x")).status).toBe(404);
  });
});

describe("PUT /v1/projects/:projectId/access (replace-set)", () => {
  it("applies the exact set and returns the aggregated delta", async () => {
    // proj-1 currently: users {MEMBER owner, ADMIN member}, groups {g-a}.
    const res = await putAccess("proj-1", {
      users: [
        { userId: MEMBER, role: "owner" },
        { userId: MEMBER2, role: "member" },
      ],
      groupIds: ["g-scim"],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: 2, removed: 2, roleChanged: 0 });

    expect(
      bindings("proj-1")
        .map((pa) => pa.userId ?? `group:${pa.groupId}`)
        .sort(),
    ).toEqual([MEMBER, MEMBER2, "group:g-scim"].sort());
    expect(store.txCount).toBe(1);
  });

  it("changes a role in place without recreating the row", async () => {
    const before = userBinding("proj-1", MEMBER)?.id;
    const res = await putAccess("proj-1", {
      users: [
        { userId: MEMBER, role: "member" },
        { userId: ADMIN, role: "owner" },
      ],
      groupIds: ["g-a"],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: 0, removed: 0, roleChanged: 2 });
    // The row id (and therefore its createdAt provenance) survives.
    expect(userBinding("proj-1", MEMBER)?.id).toBe(before);
    expect(userBinding("proj-1", MEMBER)?.role).toBe("member");
    expect(userBinding("proj-1", ADMIN)?.role).toBe("owner");
  });

  it("returns {0,0,0} for a no-op set WITHOUT opening a transaction", async () => {
    const res = await putAccess("proj-1", {
      users: [
        { userId: MEMBER, role: "owner" },
        { userId: ADMIN, role: "member" },
      ],
      groupIds: ["g-a"],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: 0, removed: 0, roleChanged: 0 });
    expect(store.txCount).toBe(0);
    expect(bindings("proj-1")).toHaveLength(3);
  });

  it("deduplicates repeated groupIds silently", async () => {
    const res = await putAccess("proj-1", {
      users: [
        { userId: MEMBER, role: "owner" },
        { userId: ADMIN, role: "member" },
      ],
      groupIds: ["g-a", "g-a"],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: 0, removed: 0, roleChanged: 0 });
  });

  it("422s a duplicate userId (ambiguous role), not 'last wins'", async () => {
    const res = await putAccess("proj-1", {
      users: [
        { userId: MEMBER, role: "owner" },
        { userId: MEMBER, role: "member" },
      ],
      groupIds: [],
    });
    expect(res.status).toBe(422);
    expect(userBinding("proj-1", MEMBER)?.role).toBe("owner");
  });

  it("422s a body missing either key — never a half-wipe", async () => {
    expect(
      (
        await putAccess("proj-1", {
          users: [{ userId: MEMBER, role: "owner" }],
        })
      ).status,
    ).toBe(422);
    expect((await putAccess("proj-1", { groupIds: [] })).status).toBe(422);
    expect(bindings("proj-1")).toHaveLength(3);
    expect(store.audits).toHaveLength(0);
  });

  it("422s arrays beyond the caps", async () => {
    const users = Array.from({ length: 1001 }, (_, i) => ({
      userId: `u-${i}`,
      role: "member" as const,
    }));
    expect((await putAccess("proj-1", { users, groupIds: [] })).status).toBe(
      422,
    );
    const groupIds = Array.from({ length: 201 }, (_, i) => `g-${i}`);
    expect(
      (
        await putAccess("proj-1", {
          users: [{ userId: MEMBER, role: "owner" }],
          groupIds,
        })
      ).status,
    ).toBe(422);
  });

  it("400s when ANY userId is not a member of this org — the security core", async () => {
    const res = await putAccess("proj-1", {
      users: [
        { userId: MEMBER, role: "owner" },
        { userId: OUTSIDER, role: "member" },
      ],
      groupIds: ["g-a"],
    });
    expect(res.status).toBe(400);
    expect(bindings("proj-1")).toHaveLength(3);
    expect(store.txCount).toBe(0);
    expect(store.audits).toHaveLength(0);
  });

  it("400s when a groupId belongs to another organization", async () => {
    const res = await putAccess("proj-1", {
      users: [{ userId: MEMBER, role: "owner" }],
      groupIds: ["g-x"],
    });
    expect(res.status).toBe(400);
    expect(bindings("proj-1")).toHaveLength(3);
    expect(store.audits).toHaveLength(0);
  });

  it("accepts a scim group as a grantee (a project grant is OneCLI-owned)", async () => {
    const res = await putAccess("proj-1", {
      users: [
        { userId: MEMBER, role: "owner" },
        { userId: ADMIN, role: "member" },
      ],
      groupIds: ["g-a", "g-scim"],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: 1, removed: 0, roleChanged: 0 });
  });

  it("allows granting a suspended member (auth-time gate)", async () => {
    const row = store.members.find((m) => m.userId === MEMBER2);
    if (row) row.status = "suspended";
    const res = await putAccess("proj-1", {
      users: [
        { userId: MEMBER, role: "owner" },
        { userId: ADMIN, role: "member" },
        { userId: MEMBER2, role: "member" },
      ],
      groupIds: ["g-a"],
    });
    expect(res.status).toBe(200);
    expect(userBinding("proj-1", MEMBER2)).toBeTruthy();
  });

  it("400s when the resulting set has no owner (demoted, or cleared)", async () => {
    const demoted = await putAccess("proj-1", {
      users: [
        { userId: MEMBER, role: "member" },
        { userId: ADMIN, role: "member" },
      ],
      groupIds: ["g-a"],
    });
    expect(demoted.status).toBe(400);

    const cleared = await putAccess("proj-1", { users: [], groupIds: [] });
    expect(cleared.status).toBe(400);

    expect(bindings("proj-1")).toHaveLength(3);
    expect(userBinding("proj-1", MEMBER)?.role).toBe("owner");
    expect(store.audits).toHaveLength(0);
  });

  it("400s a NON-ADMIN actor removing or demoting their own binding", async () => {
    store.sessionUserId = MEMBER;
    const removed = await putAccess(
      "proj-1",
      { users: [{ userId: ADMIN, role: "owner" }], groupIds: ["g-a"] },
      {},
    );
    expect(removed.status).toBe(400);

    const demoted = await putAccess(
      "proj-1",
      {
        users: [
          { userId: MEMBER, role: "member" },
          { userId: ADMIN, role: "owner" },
        ],
        groupIds: ["g-a"],
      },
      {},
    );
    expect(demoted.status).toBe(400);

    expect(userBinding("proj-1", MEMBER)?.role).toBe("owner");
    expect(store.audits).toHaveLength(0);
  });

  it("lets an ORG ADMIN remove their own binding (the hand-off exemption)", async () => {
    const res = await putAccess("proj-1", {
      users: [{ userId: MEMBER, role: "owner" }],
      groupIds: ["g-a"],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: 0, removed: 1, roleChanged: 0 });
    expect(userBinding("proj-1", ADMIN)).toBeUndefined();
  });

  it("400s an ORG ADMIN whose own removal would leave them no project", async () => {
    // Strip every path ADMIN has outside proj-1: the binding under the knife
    // becomes their ONLY route to any project, so removing it would 401 them
    // out of the dashboard — including out of the endpoint that re-grants.
    const gamma = store.projects.find((p) => p.id === "proj-3");
    if (gamma) gamma.createdByUserId = OWNER;
    store.projectAccess = store.projectAccess.filter((pa) => pa.id !== "pa-6");

    const res = await putAccess("proj-1", {
      users: [{ userId: MEMBER, role: "owner" }],
      groupIds: ["g-a"],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(
      "leave you with no project",
    );
    expect(userBinding("proj-1", ADMIN)).toBeTruthy();
    expect(store.txCount).toBe(0);
    expect(store.audits).toHaveLength(0);
  });

  it("lets an ORG ADMIN drop their own binding on a project they CREATED", async () => {
    // proj-3 is ADMIN's own project, so the created-by arm survives the write
    // even with no binding left anywhere (their proj-1 row is removed here).
    store.projectAccess = store.projectAccess.filter((pa) => pa.id !== "pa-3");

    const res = await putAccess("proj-3", {
      users: [{ userId: MEMBER, role: "owner" }],
      groupIds: [],
    });
    expect(res.status).toBe(200);
    expect(userBinding("proj-3", ADMIN)).toBeUndefined();
  });

  it("writes exactly one of userId/groupId per created row (the DB CHECK)", async () => {
    const res = await putAccess("proj-1", {
      users: [
        { userId: MEMBER, role: "owner" },
        { userId: MEMBER2, role: "member" },
      ],
      groupIds: ["g-a", "g-scim"],
    });
    expect(res.status).toBe(200);
    for (const row of store.projectAccess) {
      const principals = [row.userId, row.groupId].filter((v) => v !== null);
      expect(principals).toHaveLength(1);
    }
  });

  it("always stores group rows with role member", async () => {
    await putAccess("proj-1", {
      users: [{ userId: MEMBER, role: "owner" }],
      groupIds: ["g-scim"],
    });
    const groupRows = bindings("proj-1").filter((pa) => pa.groupId !== null);
    expect(groupRows.map((pa) => pa.groupId)).toEqual(["g-scim"]);
    expect(groupRows.every((pa) => pa.role === "member")).toBe(true);
  });

  it("audits counts only — never id arrays", async () => {
    const res = await putAccess("proj-1", {
      users: [
        { userId: MEMBER, role: "owner" },
        { userId: MEMBER2, role: "member" },
      ],
      groupIds: [],
    });
    expect(res.status).toBe(200);
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({
      organizationId: ORG,
      projectId: "proj-1",
      action: "update",
      service: "project",
      source: "api",
      metadata: {
        projectId: "proj-1",
        change: "access",
        added: 1,
        removed: 2,
        roleChanged: 0,
      },
    });
    for (const value of Object.values(store.audits[0]?.metadata ?? {})) {
      expect(Array.isArray(value)).toBe(false);
    }
  });

  it("404s a cross-org project BEFORE validating the payload (no existence oracle)", async () => {
    const res = await putAccess("proj-x", {
      users: [{ userId: OUTSIDER, role: "owner" }],
      groupIds: ["g-x"],
    });
    expect(res.status).toBe(404);
    expect(bindings("proj-x")).toHaveLength(1);
  });

  it("403s a non-manager and writes nothing", async () => {
    store.sessionUserId = MEMBER2;
    const res = await putAccess(
      "proj-2",
      { users: [{ userId: MEMBER2, role: "owner" }], groupIds: [] },
      {},
    );
    expect(res.status).toBe(403);
    expect(userBinding("proj-2", MEMBER2)?.role).toBe("member");
    expect(store.audits).toHaveLength(0);
  });
});

describe("DELETE /v1/projects/:projectId", () => {
  it("deletes the project and every child table, in ONE transaction", async () => {
    // proj-4 has no bindings and its creator (OWNER) still has proj-2.
    // Give it children so the pinned cascade has something to remove — with a
    // DISTINCT count per table, so a mis-ordered `Promise.all` destructure in
    // the audit metadata cannot pass unnoticed.
    const seed = (n: number, push: (id: string) => void) => {
      for (let i = 0; i < n; i++) push(`x-${i}`);
    };
    seed(1, (id) => store.agents.push({ id: `ag-${id}`, projectId: "proj-4" }));
    seed(2, (id) =>
      store.apiKeys.push({
        id: `k-${id}`,
        projectId: "proj-4",
        key: `oc_key-4-${id}`,
      }),
    );
    seed(3, (id) => store.secrets.push({ id: `s-${id}`, projectId: "proj-4" }));
    seed(4, (id) =>
      store.policyRules.push({ id: `pr-${id}`, projectId: "proj-4" }),
    );
    seed(5, (id) =>
      store.policyRulesV2.push({ id: `pv-${id}`, projectId: "proj-4" }),
    );
    seed(6, (id) =>
      store.appConnections.push({ id: `ac-${id}`, projectId: "proj-4" }),
    );
    seed(7, (id) =>
      store.appConfigs.push({ id: `cfg-${id}`, projectId: "proj-4" }),
    );
    seed(8, (id) =>
      store.vaultConnections.push({ id: `vc-${id}`, projectId: "proj-4" }),
    );
    seed(9, (id) => store.budgets.push({ id: `b-${id}`, projectId: "proj-4" }));
    seed(10, (id) =>
      store.onboardingSurveys.push({ id: `os-${id}`, projectId: "proj-4" }),
    );

    const res = await remove("proj-4");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: "proj-4",
      name: "Delta",
      removed: {
        agents: 1,
        apiKeys: 2,
        secrets: 3,
        policyRules: 4,
        policyRulesV2: 5,
        appConnections: 6,
        appConfigs: 7,
        vaultConnections: 8,
        budgets: 9,
        onboardingSurvey: 10,
        accessBindings: 0,
      },
    });

    expect(projectRow("proj-4")).toBeUndefined();
    for (const rows of [
      store.agents,
      store.apiKeys,
      store.secrets,
      store.appConnections,
      store.appConfigs,
      store.policyRules,
      store.policyRulesV2,
      store.vaultConnections,
      store.budgets,
      store.onboardingSurveys,
    ]) {
      expect(rows.some((r) => r.projectId === "proj-4")).toBe(false);
    }
    // Other projects' rows are untouched.
    expect(store.agents.filter((a) => a.projectId === "proj-1")).toHaveLength(
      2,
    );
    expect(bindings("proj-1")).toHaveLength(3);
    expect(store.txCount).toBe(1);
  });

  it("hands the keys captured BEFORE the delete to the gateway flush", async () => {
    store.apiKeys.push({ id: "k-4", projectId: "proj-4", key: "oc_key-4" });
    const res = await remove("proj-4");
    expect(res.status).toBe(200);
    expect(flushes.keys).toContainEqual(["oc_key-4"]);
  });

  it("audits with organizationId and NO projectId (the FK would drop the row)", async () => {
    const res = await remove("proj-4");
    expect(res.status).toBe(200);
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({
      organizationId: ORG,
      userId: ADMIN,
      action: "delete",
      service: "project",
      source: "api",
      metadata: { projectId: "proj-4", name: "Delta" },
    });
    expect(store.audits[0]?.projectId).toBeUndefined();
  });

  it("409s the organization's last project and deletes nothing", async () => {
    store.projects = store.projects.filter(
      (p) => p.id === "proj-1" || p.organizationId === OTHER_ORG,
    );
    const res = await remove("proj-1");
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("at least one project");
    expect(projectRow("proj-1")).toBeTruthy();
    expect(store.audits).toHaveLength(0);
  });

  it("409s when a directly-bound member would be left with no project", async () => {
    // proj-1 is MEMBER's only project (created + bound).
    const res = await remove("proj-1");
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("1 member(s) with no project");
    expect(projectRow("proj-1")).toBeTruthy();
    expect(store.agents.some((a) => a.projectId === "proj-1")).toBe(true);
    expect(store.audits).toHaveLength(0);
  });

  it("409s when the only path is a GROUP binding", async () => {
    // Give MEMBER another project so only the group-bound MEMBER2 is stranded.
    store.projectAccess.push(
      access("pa-20", "proj-3", { userId: MEMBER }, "member", at(20)),
    );
    // ...and take away MEMBER2's direct binding elsewhere.
    store.projectAccess = store.projectAccess.filter((pa) => pa.id !== "pa-5");

    const res = await remove("proj-1");
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("1 member(s) with no project");
    expect(projectRow("proj-1")).toBeTruthy();
  });

  it("409s with the sharper message when the ACTOR would be stranded", async () => {
    store.sessionUserId = MEMBER; // owner binding on proj-1, their only project
    const res = await remove("proj-1", {});
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("leave you with no project");
    expect(projectRow("proj-1")).toBeTruthy();
  });

  // The /projects page renders these refusals verbatim inline in the delete
  // dialog, so the EXACT wording is UI contract, not just substring flavour.
  it("pins the exact last-project refusal message", async () => {
    store.projects = store.projects.filter(
      (p) => p.id === "proj-1" || p.organizationId === OTHER_ORG,
    );
    const res = await remove("proj-1");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe(
      "An organization must keep at least one project.",
    );
  });

  it("pins the exact stranded-actor refusal message", async () => {
    store.sessionUserId = MEMBER; // owner binding on proj-1, their only project
    const res = await remove("proj-1", {});
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe(
      "Deleting this project would leave you with no project.",
    );
  });

  it("pins the exact stranded-member refusal message", async () => {
    // proj-1 is MEMBER's only project (created + bound).
    const res = await remove("proj-1");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe(
      "Deleting this project would leave 1 member(s) with no project. Give them access to another project first.",
    );
  });

  it("200s when the bound users resolve another project through a BINDING", async () => {
    // proj-2's candidates: OWNER (also created proj-4) and MEMBER2 (bound to
    // proj-1 through g-a) — `hasResolvableProjectExcluding`'s binding arm.
    const res = await remove("proj-2");
    expect(res.status).toBe(200);
    expect(projectRow("proj-2")).toBeUndefined();
  });

  it("200s when a bound user resolves a project they CREATED", async () => {
    // The other arm: MEMBER's only path was proj-1 until they create proj-5.
    store.projects.push({
      id: "proj-5",
      organizationId: ORG,
      name: "Epsilon",
      slug: "epsilon",
      createdByUserId: MEMBER,
      createdByUserEmail: "member@example.com",
      createdAt: at(30),
    });
    const res = await remove("proj-1");
    expect(res.status).toBe(200);
    expect(projectRow("proj-1")).toBeUndefined();
  });

  it("does not let a SUSPENDED member's binding block the delete", async () => {
    const row = store.members.find((m) => m.userId === MEMBER);
    if (row) row.status = "suspended";
    // MEMBER (suspended) is the only otherwise-stranded candidate on proj-1.
    const res = await remove("proj-1");
    expect(res.status).toBe(200);
    expect(projectRow("proj-1")).toBeUndefined();
  });

  it("404s a project of another organization", async () => {
    const res = await remove("proj-x");
    expect(res.status).toBe(404);
    expect(projectRow("proj-x")).toBeTruthy();
    expect(store.audits).toHaveLength(0);
  });

  it("403s a non-manager and deletes nothing", async () => {
    store.sessionUserId = MEMBER2;
    const res = await remove("proj-2", {});
    expect(res.status).toBe(403);
    expect(projectRow("proj-2")).toBeTruthy();
    expect(store.audits).toHaveLength(0);
  });
});
