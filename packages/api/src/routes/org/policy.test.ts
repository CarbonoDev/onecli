import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../../types";

// `/v1/org/policy` end-to-end through the real app: the OSS org routes mounted
// on the `eeRoutes` seam, the OSS role resolver wired as the RoleResolver, and
// `CAPS.rbac` on. Admin callers arrive with an ORG API key; the non-admin cases
// use a session, since a non-admin's org key fails key authentication outright.
// (Same harness shape as groups.test.ts — cloned, not shared — with an
// in-memory `policy_rules_v2` + identity/target row store, because the whole
// point of this router is which SCOPE the shared policy handlers write in.)

const ORG = "org-1";
const OTHER_ORG = "org-2";
const PROJECT = "proj-1";
const OWNER = "user-owner";
const ADMIN = "user-admin";
const MEMBER = "user-member";
const SUSPENDED = "user-suspended";
const OUTSIDER = "user-outsider";
const ADMIN_KEY = "oc_org_admin-key";
const OTHER_ADMIN_KEY = "oc_org_outsider-key";
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

interface RuleRow {
  id: string;
  scope: string;
  organizationId: string | null;
  projectId: string | null;
  status: string;
  generation: number;
  priority: number;
  enabled: boolean;
  isDefault: boolean;
  logicalId: string;
  source: string;
  name: string;
  description: string | null;
  action: string;
  rateLimit: number | null;
  rateLimitWindow: string | null;
  requireApproval: boolean;
  conditions: unknown;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface IdentityRow {
  id: string;
  ruleId: string;
  agentId: string | null;
  userId: string | null;
  groupId: string | null;
}

interface TargetRow {
  id: string;
  ruleId: string;
  kind: string;
  appProvider: string | null;
  appTools: string[];
  appConnectionScope: string | null;
  appConnectionId: string | null;
  secretId: string | null;
  secretScope: string | null;
  hostPattern: string | null;
  pathPattern: string | null;
  method: string | null;
}

interface DirectoryRow {
  id: string;
  organizationId: string;
}

interface ResourceRow {
  id: string;
  organizationId: string | null;
  projectId: string | null;
  scope: string;
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
  members: [] as MemberRow[],
  users: [] as UserRow[],
  rules: [] as RuleRow[],
  identities: [] as IdentityRow[],
  targets: [] as TargetRow[],
  groups: [] as DirectoryRow[],
  connections: [] as ResourceRow[],
  secrets: [] as ResourceRow[],
  audits: [] as AuditRow[],
  seq: 0,
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

  // The subset of `where` shapes the policy service actually builds.
  interface RuleWhere {
    id?: string;
    scope?: string;
    organizationId?: string;
    projectId?: string;
    status?: string;
    isDefault?: boolean;
    generation?: number | { lte: number };
  }
  interface OrgMemberWhere {
    organizationId?: string;
    userId?: string | { in: string[] };
    role?: string | { not?: string };
    status?: string | { not?: string };
  }
  interface IdWhere {
    id?: { in: string[] };
    organizationId?: string;
    projectId?: string;
    scope?: string;
  }

  const nextId = (prefix: string) => `${prefix}-${++store.seq}`;

  const matchesRule = (row: RuleRow, where: RuleWhere = {}) => {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.scope !== undefined && row.scope !== where.scope) return false;
    // `undefined` means "not fenced"; the service always passes exactly one of
    // organizationId / projectId (policyScope's invariant).
    if (
      where.organizationId !== undefined &&
      row.organizationId !== where.organizationId
    )
      return false;
    if (where.projectId !== undefined && row.projectId !== where.projectId)
      return false;
    if (where.status !== undefined && row.status !== where.status) return false;
    if (where.isDefault !== undefined && row.isDefault !== where.isDefault)
      return false;
    if (where.generation !== undefined) {
      if (typeof where.generation === "number") {
        if (row.generation !== where.generation) return false;
      } else if (row.generation > where.generation.lte) return false;
    }
    return true;
  };

  const filterRules = (where?: RuleWhere) =>
    store.rules.filter((row) => matchesRule(row, where));

  const withRelations = (
    row: RuleRow,
    include?: { identities?: boolean; targets?: boolean },
  ) => ({
    ...row,
    ...(include?.identities
      ? { identities: store.identities.filter((i) => i.ruleId === row.id) }
      : {}),
    ...(include?.targets
      ? { targets: store.targets.filter((t) => t.ruleId === row.id) }
      : {}),
  });

  const pickRule = (
    row: RuleRow,
    select?: Record<string, boolean>,
    include?: { identities?: boolean; targets?: boolean },
  ) => {
    if (!select) return withRelations(row, include);
    const picked: Record<string, unknown> = {};
    for (const key of Object.keys(select)) {
      if (select[key]) picked[key] = row[key as keyof RuleRow];
    }
    return picked;
  };

  /** A nested identity `create` entry — `{ group: { connect: { id } } }`. */
  interface IdentityCreate {
    agent?: { connect: { id: string } };
    user?: { connect: { id: string } };
    group?: { connect: { id: string } };
  }
  /** A nested target `create` entry — scalars plus optional relation connects. */
  interface TargetCreate {
    kind: string;
    appProvider?: string | null;
    appTools?: string[];
    appConnectionScope?: string | null;
    appConnection?: { connect: { id: string } };
    secret?: { connect: { id: string } };
    secretId?: string | null;
    secretScope?: string | null;
    hostPattern?: string | null;
    pathPattern?: string | null;
    method?: string | null;
  }
  interface RuleCreateData {
    scope: string;
    organizationId?: string;
    projectId?: string;
    status?: string;
    generation?: number;
    priority: number;
    enabled?: boolean;
    isDefault?: boolean;
    logicalId?: string;
    source?: string;
    name: string;
    description?: string | null;
    action: string;
    rateLimit?: number | null;
    rateLimitWindow?: string | null;
    requireApproval?: boolean;
    conditions?: unknown;
    createdByUserId?: string | null;
    identities?: { create: IdentityCreate[] };
    targets?: { create: TargetCreate[] };
  }

  const writeIdentities = (ruleId: string, entries: IdentityCreate[]) => {
    for (const entry of entries) {
      // The DB CHECK allows exactly one principal per row; the mock mirrors it
      // so a malformed nested create surfaces here instead of silently storing
      // an all-null row that would decode as "any".
      const row: IdentityRow = {
        id: nextId("pri"),
        ruleId,
        agentId: entry.agent?.connect.id ?? null,
        userId: entry.user?.connect.id ?? null,
        groupId: entry.group?.connect.id ?? null,
      };
      store.identities.push(row);
    }
  };

  const writeTargets = (ruleId: string, entries: TargetCreate[]) => {
    for (const entry of entries) {
      store.targets.push({
        id: nextId("tgt"),
        ruleId,
        kind: entry.kind,
        appProvider: entry.appProvider ?? null,
        appTools: entry.appTools ?? [],
        appConnectionScope: entry.appConnectionScope ?? null,
        appConnectionId: entry.appConnection?.connect.id ?? null,
        secretId: entry.secret?.connect.id ?? entry.secretId ?? null,
        secretScope: entry.secretScope ?? null,
        hostPattern: entry.hostPattern ?? null,
        pathPattern: entry.pathPattern ?? null,
        method: entry.method ?? null,
      });
    }
  };

  const createRule = ({
    data,
    include,
  }: {
    data: RuleCreateData;
    include?: { identities?: boolean; targets?: boolean };
  }) => {
    const now = new Date();
    const row: RuleRow = {
      id: nextId("r"),
      scope: data.scope,
      organizationId: data.organizationId ?? null,
      projectId: data.projectId ?? null,
      status: data.status ?? "draft",
      generation: data.generation ?? 0,
      priority: data.priority,
      enabled: data.enabled ?? true,
      isDefault: data.isDefault ?? false,
      // `@default(gen_random_uuid())` in the schema — a snapshot copies its
      // source draft's, which is what keeps rate counters stable.
      logicalId: data.logicalId ?? nextId("logical"),
      source: data.source ?? "custom",
      name: data.name,
      description: data.description ?? null,
      action: data.action,
      rateLimit: data.rateLimit ?? null,
      rateLimitWindow: data.rateLimitWindow ?? null,
      requireApproval: data.requireApproval ?? false,
      conditions: data.conditions ?? null,
      createdByUserId: data.createdByUserId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    store.rules.push(row);
    writeIdentities(row.id, data.identities?.create ?? []);
    writeTargets(row.id, data.targets?.create ?? []);
    return withRelations(row, include);
  };

  const dropRules = (ids: Set<string>) => {
    store.rules = store.rules.filter((r) => !ids.has(r.id));
    // The FK cascade on PolicyRuleIdentity / PolicyRuleTarget.
    store.identities = store.identities.filter((i) => !ids.has(i.ruleId));
    store.targets = store.targets.filter((t) => !ids.has(t.ruleId));
  };

  const policyRuleV2 = {
    aggregate: async ({
      where,
      _max,
    }: {
      where?: RuleWhere;
      _max?: { generation?: boolean; priority?: boolean };
    }) => {
      const rows = filterRules(where);
      const max = (values: number[]) =>
        values.length === 0 ? null : Math.max(...values);
      return {
        _max: {
          ...(_max?.generation
            ? { generation: max(rows.map((r) => r.generation)) }
            : {}),
          ...(_max?.priority
            ? { priority: max(rows.map((r) => r.priority)) }
            : {}),
        },
      };
    },
    count: async ({ where }: { where?: RuleWhere }) =>
      filterRules(where).length,
    findMany: async ({
      where,
      include,
      select,
    }: {
      where?: RuleWhere;
      orderBy?: unknown;
      include?: { identities?: boolean; targets?: boolean };
      select?: Record<string, boolean>;
    }) =>
      filterRules(where)
        .slice()
        // The service always asks for [{ priority: asc }, { id: asc }] — the
        // exact order the gateway's loader mirrors, so it is hard-coded here
        // rather than interpreted.
        .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
        .map((row) => pickRule(row, select, include)),
    findFirst: async ({
      where,
      include,
      select,
    }: {
      where?: RuleWhere;
      include?: { identities?: boolean; targets?: boolean };
      select?: Record<string, boolean>;
    }) => {
      const row = filterRules(where)
        .slice()
        .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))[0];
      return row ? pickRule(row, select, include) : null;
    },
    create: createRule,
    update: async ({
      where,
      data,
      include,
    }: {
      where: { id: string };
      data: Partial<RuleCreateData> & {
        identities?: { create: IdentityCreate[] };
        targets?: { create: TargetCreate[] };
      };
      include?: { identities?: boolean; targets?: boolean };
    }) => {
      const row = store.rules.find((r) => r.id === where.id);
      if (!row) {
        throw new PrismaClientKnownRequestError("Record not found", "P2025");
      }
      for (const [key, value] of Object.entries(data)) {
        if (key === "identities" || key === "targets") continue;
        (row as unknown as Record<string, unknown>)[key] = value;
      }
      row.updatedAt = new Date();
      if (data.identities) writeIdentities(row.id, data.identities.create);
      if (data.targets) writeTargets(row.id, data.targets.create);
      return withRelations(row, include);
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const row = store.rules.find((r) => r.id === where.id);
      if (!row) {
        throw new PrismaClientKnownRequestError("Record not found", "P2025");
      }
      dropRules(new Set([row.id]));
      return row;
    },
    deleteMany: async ({ where }: { where?: RuleWhere }) => {
      const rows = filterRules(where);
      dropRules(new Set(rows.map((r) => r.id)));
      return { count: rows.length };
    },
  };

  const policyRuleIdentity = {
    findMany: async ({ where }: { where: Partial<IdentityRow> }) =>
      store.identities.filter((row) =>
        Object.entries(where).every(
          ([key, value]) => row[key as keyof IdentityRow] === value,
        ),
      ),
    deleteMany: async ({ where }: { where: { ruleId: string } }) => {
      const before = store.identities.length;
      store.identities = store.identities.filter(
        (i) => i.ruleId !== where.ruleId,
      );
      return { count: before - store.identities.length };
    },
  };

  const policyRuleTarget = {
    deleteMany: async ({ where }: { where: { ruleId: string } }) => {
      const before = store.targets.length;
      store.targets = store.targets.filter((t) => t.ruleId !== where.ruleId);
      return { count: before - store.targets.length };
    },
  };

  const countDirectory = (rows: DirectoryRow[], where: IdWhere) =>
    rows.filter(
      (row) =>
        (where.id?.in ?? []).includes(row.id) &&
        (where.organizationId === undefined ||
          row.organizationId === where.organizationId),
    ).length;

  const countResources = (rows: ResourceRow[], where: IdWhere) =>
    rows.filter(
      (row) =>
        (where.id?.in ?? []).includes(row.id) &&
        (where.organizationId === undefined ||
          row.organizationId === where.organizationId) &&
        (where.projectId === undefined || row.projectId === where.projectId) &&
        (where.scope === undefined || row.scope === where.scope),
    ).length;

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

  const db = {
    apiKey: {
      findUnique: async ({ where }: { where: { key?: string } }) => {
        if (where.key === "oc_org_admin-key")
          return {
            userId: "user-admin",
            organizationId: "org-1",
            scope: "organization",
          };
        if (where.key === "oc_org_outsider-key")
          return {
            userId: "user-outsider",
            organizationId: "org-2",
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
      findFirst: async ({ where }: { where: OrgMemberWhere }) =>
        filterOrgMembers(where)[0] ?? null,
      findMany: async ({ where }: { where: OrgMemberWhere }) =>
        filterOrgMembers(where),
      // The identity ownership check: a suspended member is excluded by
      // `status: { not: "suspended" }`, so this count is what makes a rule
      // targeting a suspended user a 422.
      count: async ({ where }: { where: OrgMemberWhere & IdWhere }) =>
        filterOrgMembers(where).filter((row) =>
          (where.id?.in ?? [row.userId]).includes(row.userId),
        ).length,
    },
    group: {
      count: async ({ where }: { where: IdWhere }) =>
        countDirectory(store.groups, where),
    },
    agent: { count: async () => 0 },
    appConnection: {
      count: async ({ where }: { where: IdWhere }) =>
        countResources(store.connections, where),
      findMany: async () => [],
    },
    secret: {
      count: async ({ where }: { where: IdWhere }) =>
        countResources(store.secrets, where),
    },
    project: {
      findFirst: async () => ({ id: "proj-1", organizationId: "org-1" }),
      findUnique: async () => ({ id: "proj-1", organizationId: "org-1" }),
    },
    projectAccess: { findFirst: async () => null },
    policyRuleV2,
    policyRuleIdentity,
    policyRuleTarget,
    auditLog: {
      create: async ({ data }: { data: AuditRow }) => {
        store.audits.push(data);
        return data;
      },
    },
    // The policy service uses the INTERACTIVE form; the org group/agent-group
    // services (not exercised here) use the array form. Support both.
    $transaction: async (arg: unknown) => {
      if (typeof arg === "function") {
        const tx = {
          // lockScope's advisory lock — a tagged template.
          $executeRaw: async () => 0,
          policyRuleV2,
          policyRuleIdentity,
          policyRuleTarget,
        };
        return (arg as (tx: unknown) => Promise<unknown>)(tx);
      }
      return Promise.all(arg as Promise<unknown>[]);
    },
  };

  return {
    Prisma: { JsonNull: null, PrismaClientKnownRequestError },
    db,
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
  status = "active",
): MemberRow => ({
  organizationId,
  userId,
  userEmail: `${userId}@example.com`,
  role,
  status,
  ssoExempt: false,
  suspendedAt: status === "suspended" ? createdAt : null,
  createdAt,
});

const rule = (id: string, overrides: Partial<RuleRow> = {}): RuleRow => ({
  id,
  scope: "organization",
  organizationId: ORG,
  projectId: null,
  status: "draft",
  generation: 0,
  priority: 1,
  enabled: true,
  isDefault: false,
  logicalId: `logical-${id}`,
  source: "custom",
  name: id,
  description: null,
  action: "block",
  rateLimit: null,
  rateLimitWindow: null,
  requireApproval: false,
  conditions: null,
  createdByUserId: ADMIN,
  createdAt: at(1),
  updatedAt: at(1),
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
      email: "member@example.com",
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
    member(SUSPENDED, "member", at(3), ORG, "suspended"),
    member(OUTSIDER, "admin", at(4), OTHER_ORG),
  ];
  store.groups = [
    { id: "g-1", organizationId: ORG },
    { id: "g-2", organizationId: ORG },
    { id: "g-x", organizationId: OTHER_ORG },
  ];
  store.connections = [
    {
      id: "conn-org",
      organizationId: ORG,
      projectId: null,
      scope: "organization",
    },
    {
      id: "conn-proj",
      organizationId: ORG,
      projectId: PROJECT,
      scope: "project",
    },
  ];
  store.secrets = [
    {
      id: "sec-org",
      organizationId: ORG,
      projectId: null,
      scope: "organization",
    },
    {
      id: "sec-proj",
      organizationId: ORG,
      projectId: PROJECT,
      scope: "project",
    },
  ];
  store.rules = [
    // Two org-1 draft rules, deliberately seeded out of priority order.
    rule("r-b", { priority: 2, name: "Block paste sites" }),
    rule("r-a", { priority: 1, name: "Block internal admin API" }),
    // Another org's rule, and this org's PROJECT rule — neither may ever
    // appear through /v1/org/policy.
    rule("r-foreign", { organizationId: OTHER_ORG, name: "Foreign" }),
    rule("r-project", {
      scope: "project",
      organizationId: null,
      projectId: PROJECT,
      name: "Project rule",
    }),
  ];
  store.identities = [
    {
      id: "pri-a",
      ruleId: "r-a",
      agentId: null,
      userId: null,
      groupId: "g-1",
    },
  ];
  store.targets = [
    {
      id: "tgt-a",
      ruleId: "r-a",
      kind: "network",
      appProvider: null,
      appTools: [],
      appConnectionScope: null,
      appConnectionId: null,
      secretId: null,
      secretScope: null,
      hostPattern: "admin.internal",
      pathPattern: null,
      method: null,
    },
  ];
  store.audits = [];
  store.seq = 1000;
  store.sessionUserId = null;
});

const asAdmin = { headers: { Authorization: `Bearer ${ADMIN_KEY}` } };
const asOtherAdmin = {
  headers: { Authorization: `Bearer ${OTHER_ADMIN_KEY}` },
};
const asProjectKey = { headers: { Authorization: `Bearer ${PROJECT_KEY}` } };

interface RuleBody {
  id: string;
  scope: string;
  name: string;
  priority: number;
  action: string;
  isDefault: boolean;
  identities: { type: string; id: string }[];
  targets: Record<string, unknown>[];
}

const NETWORK_TARGET = { kind: "network", hostPattern: "example.com" };

const listRules = async (
  init: RequestInit = asAdmin,
  query = "",
): Promise<RuleBody[]> => {
  const res = await app.request(`/v1/org/policy/rules${query}`, init);
  expect(res.status).toBe(200);
  return (await res.json()) as RuleBody[];
};

const create = (body: unknown, init: RequestInit = asAdmin) =>
  app.request("/v1/org/policy/rules", {
    ...init,
    method: "POST",
    body: JSON.stringify(body),
  });

const patch = (id: string, body: unknown, init: RequestInit = asAdmin) =>
  app.request(`/v1/org/policy/rules/${id}`, {
    ...init,
    method: "PATCH",
    body: JSON.stringify(body),
  });

const remove = (id: string, init: RequestInit = asAdmin) =>
  app.request(`/v1/org/policy/rules/${id}`, { ...init, method: "DELETE" });

const reorder = (orderedIds: string[], init: RequestInit = asAdmin) =>
  app.request("/v1/org/policy/rules/order", {
    ...init,
    method: "PUT",
    body: JSON.stringify({ orderedIds }),
  });

const setDefault = (action: string, init: RequestInit = asAdmin) =>
  app.request("/v1/org/policy/default", {
    ...init,
    method: "PATCH",
    body: JSON.stringify({ action }),
  });

const publish = (init: RequestInit = asAdmin) =>
  app.request("/v1/org/policy/publish", {
    ...init,
    method: "POST",
    body: "{}",
  });

const orgRules = (status = "draft") =>
  store.rules.filter((r) => r.organizationId === ORG && r.status === status);

const identitiesOf = (ruleId: string) =>
  store.identities.filter((i) => i.ruleId === ruleId);

describe("mount + scope fencing", () => {
  it("serves the org's own organization-scope rules, in priority order", async () => {
    const body = await listRules();
    expect(body.map((r) => r.id)).toEqual(["r-a", "r-b"]);
    expect(body[0]).toMatchObject({
      id: "r-a",
      scope: "organization",
      name: "Block internal admin API",
      identities: [{ type: "group", id: "g-1" }],
    });
  });

  it("never returns another org's rules, nor this org's PROJECT rules", async () => {
    const body = await listRules();
    const ids = body.map((r) => r.id);
    expect(ids).not.toContain("r-foreign");
    expect(ids).not.toContain("r-project");
  });

  it("writes rules into the ORGANIZATION scope, never a project", async () => {
    const res = await create({
      name: "Block pastebin",
      action: "block",
      targets: [NETWORK_TARGET],
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as RuleBody;
    const row = store.rules.find((r) => r.id === created.id);
    expect(row).toMatchObject({
      scope: "organization",
      organizationId: ORG,
      projectId: null,
      status: "draft",
      isDefault: false,
    });
  });

  it("appends a new rule below the existing ones (manual ordering)", async () => {
    const res = await create({
      name: "Appended",
      action: "block",
      targets: [NETWORK_TARGET],
    });
    const created = (await res.json()) as RuleBody;
    expect(created.priority).toBe(3);
    expect((await listRules()).map((r) => r.id)).toEqual([
      "r-a",
      "r-b",
      created.id,
    ]);
  });
});

describe("authorization", () => {
  it("403s every verb for a non-admin member session", async () => {
    store.sessionUserId = MEMBER;
    const asMember: RequestInit = {};
    const responses = await Promise.all([
      app.request("/v1/org/policy/rules", asMember),
      app.request("/v1/org/policy/default", asMember),
      create(
        { name: "x", action: "block", targets: [NETWORK_TARGET] },
        asMember,
      ),
      patch("r-a", { name: "y" }, asMember),
      remove("r-a", asMember),
      reorder(["r-a", "r-b"], asMember),
      setDefault("allow", asMember),
      publish(asMember),
    ]);
    expect(responses.map((r) => r.status)).toEqual([
      403, 403, 403, 403, 403, 403, 403, 403,
    ]);
    // Nothing changed behind the 403s.
    expect(
      orgRules()
        .map((r) => r.id)
        .sort(),
    ).toEqual(["r-a", "r-b"]);
  });

  it("403s a PROJECT-scoped key even when its holder is an org admin", async () => {
    // The Slice-3 invariant, and the security test that matters most here:
    // `role` is scope-blind, so a leaked agent key belonging to an admin would
    // otherwise rewrite the guardrails its own traffic is judged against.
    const res = await app.request("/v1/org/policy/rules", asProjectKey);
    expect(res.status).toBe(403);
    const write = await create(
      { name: "x", action: "block", targets: [NETWORK_TARGET] },
      asProjectKey,
    );
    expect(write.status).toBe(403);
  });

  it("401s an unauthenticated caller (auth runs before the editing gate)", async () => {
    const res = await app.request("/v1/org/policy/rules");
    expect(res.status).toBe(401);
  });
});

describe("cross-org isolation", () => {
  it("hides org-1's rules from org-2's admin", async () => {
    const body = await listRules(asOtherAdmin);
    expect(body.map((r) => r.id)).toEqual(["r-foreign"]);
  });

  it("404s org-2's admin on org-1's rule for read, patch and delete", async () => {
    const get = await app.request("/v1/org/policy/rules/r-a", asOtherAdmin);
    expect(get.status).toBe(404);
    expect(
      (await patch("r-a", { name: "hijacked" }, asOtherAdmin)).status,
    ).toBe(404);
    expect((await remove("r-a", asOtherAdmin)).status).toBe(404);
    expect(store.rules.find((r) => r.id === "r-a")?.name).toBe(
      "Block internal admin API",
    );
  });

  it("409s a reorder that names another org's rules", async () => {
    const res = await reorder(["r-a", "r-b"], asOtherAdmin);
    expect(res.status).toBe(409);
    expect(store.rules.find((r) => r.id === "r-a")?.priority).toBe(1);
  });

  it("publishes only its own org's rules", async () => {
    const res = await publish(asOtherAdmin);
    expect(res.status).toBe(200);
    const published = store.rules.filter((r) => r.status === "published");
    expect(published.every((r) => r.organizationId === OTHER_ORG)).toBe(true);
  });
});

describe("identity authoring (the picker's contract)", () => {
  const withIdentities = (identities: unknown[]) => ({
    name: "Directory rule",
    action: "block",
    targets: [NETWORK_TARGET],
    identities,
  });

  it("accepts user and group identities, one row per principal", async () => {
    const res = await create(
      withIdentities([
        { type: "user", id: MEMBER },
        { type: "group", id: "g-1" },
        { type: "group", id: "g-2" },
      ]),
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as RuleBody;
    expect(created.identities).toEqual([
      { type: "user", id: MEMBER },
      { type: "group", id: "g-1" },
      { type: "group", id: "g-2" },
    ]);
    // Exactly one principal column per row — the shape `assemble.rs` decodes.
    for (const row of identitiesOf(created.id)) {
      const named = [row.agentId, row.userId, row.groupId].filter(
        (v) => v !== null,
      );
      expect(named).toHaveLength(1);
    }
  });

  it("accepts an empty identity set (= all agents in the organization)", async () => {
    const res = await create(withIdentities([]));
    expect(res.status).toBe(201);
    const created = (await res.json()) as RuleBody;
    expect(created.identities).toEqual([]);
    expect(identitiesOf(created.id)).toHaveLength(0);
  });

  it("422s a specific AGENT — the kind the picker must never offer", async () => {
    const res = await create(
      withIdentities([{ type: "agent", id: "agent-1" }]),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/not a specific agent/i);
  });

  it("422s a principal from another organization", async () => {
    for (const identity of [
      { type: "group", id: "g-x" },
      { type: "user", id: OUTSIDER },
    ]) {
      const res = await create(withIdentities([identity]));
      expect(res.status).toBe(422);
    }
  });

  it("422s a SUSPENDED member (the gateway drops them from the principal set)", async () => {
    const res = await create(withIdentities([{ type: "user", id: SUSPENDED }]));
    expect(res.status).toBe(422);
  });

  it("replaces the identity set on PATCH", async () => {
    const res = await patch("r-a", {
      identities: [{ type: "group", id: "g-1" }],
    });
    expect(res.status).toBe(200);
    expect(identitiesOf("r-a").map((i) => i.groupId)).toEqual(["g-1"]);
    expect(
      identitiesOf("r-a").every((i) => i.agentId === null && i.userId === null),
    ).toBe(true);
  });
});

describe("target authoring at org scope", () => {
  const withTargets = (targets: unknown[]) => ({
    name: "Target rule",
    action: "block",
    targets,
  });

  it("accepts both level markers on an org rule", async () => {
    for (const level of ["organization", "project"] as const) {
      const app_ = await create(
        withTargets([
          { kind: "app", provider: "github", connectionScope: level },
        ]),
      );
      expect(app_.status).toBe(201);
      const secret = await create(
        withTargets([{ kind: "secret", secretScope: level }]),
      );
      expect(secret.status).toBe(201);
    }
  });

  it("422s an org rule naming a PROJECT-level connection or secret", async () => {
    const conn = await create(
      withTargets([{ kind: "connection", connectionId: "conn-proj" }]),
    );
    expect(conn.status).toBe(422);
    const secret = await create(
      withTargets([{ kind: "secret", secretId: "sec-proj" }]),
    );
    expect(secret.status).toBe(422);
  });

  it("accepts an org-level connection / secret by id", async () => {
    const conn = await create(
      withTargets([{ kind: "connection", connectionId: "conn-org" }]),
    );
    expect(conn.status).toBe(201);
    const secret = await create(
      withTargets([{ kind: "secret", secretId: "sec-org" }]),
    );
    expect(secret.status).toBe(201);
  });

  it("422s a rule with no targets (an empty target set matches nothing)", async () => {
    const res = await create(withTargets([]));
    expect(res.status).toBe(422);
  });
});

describe("the Default Rule", () => {
  it("GET returns a VIRTUAL default and writes nothing", async () => {
    const res = await app.request("/v1/org/policy/default", asAdmin);
    expect(res.status).toBe(200);
    const body = (await res.json()) as RuleBody;
    // The virtual (unpersisted) default is `allow` in every scope on this base
    // (`defaultAction`); `id: ""` marks it virtual.
    expect(body).toMatchObject({ id: "", isDefault: true, action: "allow" });
    // A read must never mint a persisted default row.
    expect(store.rules.some((r) => r.isDefault)).toBe(false);
  });

  it("PATCH persists the admin's choice — an ALLOW default, not the minted Block", async () => {
    const res = await setDefault("allow");
    expect(res.status).toBe(200);
    const defaults = store.rules.filter(
      (r) => r.isDefault && r.organizationId === ORG && r.status === "draft",
    );
    expect(defaults).toHaveLength(1);
    expect(defaults[0]).toMatchObject({ action: "allow", priority: 0 });
  });

  it("PATCH is idempotent — it never mints a second default", async () => {
    await setDefault("allow");
    await setDefault("block");
    const defaults = store.rules.filter(
      (r) => r.isDefault && r.organizationId === ORG && r.status === "draft",
    );
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.action).toBe("block");
  });

  it("keeps the default out of the rules list", async () => {
    await setDefault("allow");
    expect((await listRules()).map((r) => r.id)).toEqual(["r-a", "r-b"]);
  });
});

describe("publish + generations", () => {
  it("snapshots the draft set plus the default into generation 1, then 2", async () => {
    const first = await publish();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ generation: 1, ruleCount: 3 });

    const published = store.rules.filter(
      (r) => r.organizationId === ORG && r.status === "published",
    );
    expect(published).toHaveLength(3); // r-a, r-b + the minted default
    expect(published.filter((r) => r.isDefault)).toHaveLength(1);

    const second = await publish();
    expect(await second.json()).toMatchObject({ generation: 2 });
  });

  it("copies identities and targets onto the published generation", async () => {
    await publish();
    const snapshot = store.rules.find(
      (r) => r.status === "published" && r.name === "Block internal admin API",
    );
    expect(snapshot).toBeDefined();
    expect(identitiesOf(snapshot?.id ?? "").map((i) => i.groupId)).toEqual([
      "g-1",
    ]);
    expect(
      store.targets
        .filter((t) => t.ruleId === snapshot?.id)
        .map((t) => t.hostPattern),
    ).toEqual(["admin.internal"]);
  });

  it("returns only the ACTIVE published generation from ?status=published", async () => {
    await publish();
    await publish();
    const body = await listRules(asAdmin, "?status=published");
    expect(body.map((r) => r.name).sort()).toEqual([
      "Block internal admin API",
      "Block paste sites",
    ]);
    const generations = new Set(
      body.map((r) => store.rules.find((row) => row.id === r.id)?.generation),
    );
    expect([...generations]).toEqual([2]);
  });

  it("prunes published generations beyond the retention window", async () => {
    for (let i = 0; i < 11; i++) await publish();
    const generations = store.rules
      .filter((r) => r.organizationId === ORG && r.status === "published")
      .map((r) => r.generation);
    expect(Math.max(...generations)).toBe(11);
    expect(Math.min(...generations)).toBe(2); // generation 1 pruned
  });

  it("410s a PROJECT publish — project-scope policy CRUD was retired", async () => {
    // Project rules are compiled from agent grants now; `/v1/policy/*` answers
    // 410 (`removedProjectPolicyRoutes`), so an org publish is the only writer.
    const projectPublish = await app.request("/v1/policy/publish", {
      ...asProjectKey,
      method: "POST",
      body: "{}",
      headers: { ...asProjectKey.headers, "X-Project-Id": PROJECT },
    });
    expect(projectPublish.status).toBe(410);

    const again = await publish();
    expect(await again.json()).toMatchObject({ generation: 1 });
    // No project generations were ever written.
    expect(
      store.rules.some(
        (r) => r.projectId === PROJECT && r.status === "published",
      ),
    ).toBe(false);
  });
});

describe("ordering", () => {
  it("renumbers the draft densely and returns the new order", async () => {
    const res = await reorder(["r-b", "r-a"]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as RuleBody[]).map((r) => r.id)).toEqual([
      "r-b",
      "r-a",
    ]);
    expect(store.rules.find((r) => r.id === "r-b")?.priority).toBe(1);
    expect(store.rules.find((r) => r.id === "r-a")?.priority).toBe(2);
  });

  it("409s a stale id set rather than writing a partial order", async () => {
    const missing = await reorder(["r-a"]);
    expect(missing.status).toBe(409);
    const extra = await reorder(["r-a", "r-b", "r-project"]);
    expect(extra.status).toBe(409);
    const duplicated = await reorder(["r-a", "r-a"]);
    expect(duplicated.status).toBe(409);
    expect(store.rules.find((r) => r.id === "r-a")?.priority).toBe(1);
  });
});

describe("audit + gateway cache flush", () => {
  // `withAudit` keys `invalidateGatewayCacheForOrg` off `organizationId`, so an
  // audit row missing it is also a MISSED FLUSH — the guardrail would keep
  // enforcing its old shape for the cache window.
  const expectOrgAudit = (action: string) => {
    const row = store.audits.at(-1);
    expect(row).toMatchObject({
      organizationId: ORG,
      userId: ADMIN,
      action,
      service: "policy",
      source: "api",
    });
    expect(row?.projectId).toBeUndefined();
  };

  it("audits create, update, delete, reorder, default and publish", async () => {
    const created = (await (
      await create({
        name: "Audited",
        action: "block",
        targets: [NETWORK_TARGET],
      })
    ).json()) as RuleBody;
    expectOrgAudit("create");

    await patch(created.id, { name: "Audited again" });
    expectOrgAudit("update");

    await reorder(["r-a", "r-b", created.id]);
    expectOrgAudit("update");

    await setDefault("allow");
    expectOrgAudit("update");

    await publish();
    expectOrgAudit("publish");

    await remove(created.id);
    expectOrgAudit("delete");
  });

  it("carries the rule id in the metadata (never the whole rule)", async () => {
    const created = (await (
      await create({
        name: "Metadata",
        action: "block",
        targets: [NETWORK_TARGET],
      })
    ).json()) as RuleBody;
    expect(store.audits.at(-1)?.metadata).toEqual({
      ruleId: created.id,
      name: "Metadata",
    });
  });
});
