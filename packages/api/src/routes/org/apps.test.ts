import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../../types";

// `/v1/org/apps/*` end-to-end through the real app: OSS org routes on the
// `eeRoutes` seam, the OSS role resolver, admin callers with an ORG API key.
// Same harness shape as policy.test.ts / budgets.test.ts (cloned, not shared).
// The point of this router is which SCOPE the shared config + blocklist
// handlers resolve — `appConfigKey` picks a different unique per scope, so the
// mock keys on the composite the service actually passes.

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

// `github` is configurable (clientId + secret clientSecret);
// `jfrog-artifactory` declares a blocklist (registry.npmjs.org, pypi.org).
const CONFIGURABLE = "github";
const BLOCKLIST_APP = "jfrog-artifactory";
const NPM_HOST = "registry.npmjs.org";

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

interface ConfigRow {
  id: string;
  scope: string;
  projectId: string | null;
  organizationId: string | null;
  provider: string;
  enabled: boolean;
  credentials: string | null;
  settings: Record<string, string>;
}

interface ConnectionRow {
  id: string;
  scope: string;
  projectId: string | null;
  organizationId: string | null;
  appConfigId: string | null;
  provider: string;
}

interface RuleRow {
  id: string;
  scope: string;
  projectId: string | null;
  organizationId: string | null;
  status: string;
  generation: number;
  source: string;
  logicalId: string;
  name: string;
  enabled: boolean;
  hostPattern: string;
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

interface ConfigKey {
  organizationId_provider?: { organizationId: string; provider: string };
  projectId_provider?: { projectId: string; provider: string };
}

interface ScopeWhere {
  id?: string;
  provider?: string;
  enabled?: boolean;
  scope?: string;
  projectId?: string;
  organizationId?: string;
  appConfigId?: string;
  status?: string;
  source?: string;
  logicalId?: { in: string[] } | string;
  OR?: Record<string, unknown>[];
}

const store = vi.hoisted(() => ({
  members: [] as MemberRow[],
  users: [] as UserRow[],
  configs: [] as ConfigRow[],
  connections: [] as ConnectionRow[],
  rules: [] as RuleRow[],
  audits: [] as AuditRow[],
  sessionUserId: null as string | null,
  seq: 0,
}));

vi.mock("@onecli/db", () => {
  const nextId = (prefix: string) => `${prefix}-${++store.seq}`;

  const findMember = (organizationId: string, userId: string) =>
    store.members.find(
      (m) => m.organizationId === organizationId && m.userId === userId,
    );

  /** The two `appConfigKey` composites, resolved to a row. */
  const byKey = (where: ConfigKey) => {
    const org = where.organizationId_provider;
    if (org)
      return (
        store.configs.find(
          (c) =>
            c.organizationId === org.organizationId &&
            c.provider === org.provider,
        ) ?? null
      );
    const proj = where.projectId_provider!;
    return (
      store.configs.find(
        (c) => c.projectId === proj.projectId && c.provider === proj.provider,
      ) ?? null
    );
  };

  const scopeArm = (
    row: { projectId: string | null; organizationId: string | null },
    w: { projectId?: string; organizationId?: string; scope?: string },
    rowScope: string,
  ) =>
    (w.projectId === undefined || row.projectId === w.projectId) &&
    (w.organizationId === undefined ||
      row.organizationId === w.organizationId) &&
    (w.scope === undefined || rowScope === w.scope);

  const matchesScope = (
    row: { projectId: string | null; organizationId: string | null },
    rowScope: string,
    where: ScopeWhere,
  ) => {
    if (where.OR)
      return where.OR.some((w) => scopeArm(row, w as ScopeWhere, rowScope));
    return scopeArm(row, where, rowScope);
  };

  const appConfig = {
    findUnique: async ({ where }: { where: ConfigKey }) => byKey(where),
    findMany: async ({ where }: { where: ScopeWhere }) =>
      store.configs.filter(
        (c) =>
          matchesScope(c, c.scope, where) &&
          (where.enabled === undefined || c.enabled === where.enabled),
      ),
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: ConfigKey;
      create: Partial<ConfigRow>;
      update: Partial<ConfigRow>;
    }) => {
      const existing = byKey(where);
      if (existing) {
        Object.assign(existing, update);
        return existing;
      }
      const row: ConfigRow = {
        id: nextId("cfg"),
        scope: "project",
        projectId: null,
        organizationId: null,
        provider: "",
        enabled: false,
        credentials: null,
        settings: {},
        ...create,
      };
      store.configs.push(row);
      return row;
    },
    update: async ({
      where,
      data,
    }: {
      where: ConfigKey;
      data: Partial<ConfigRow>;
    }) => {
      const row = byKey(where);
      if (!row) throw new Error("not found");
      Object.assign(row, data);
      return row;
    },
    delete: async ({ where }: { where: ConfigKey }) => {
      const row = byKey(where);
      store.configs = store.configs.filter((c) => c !== row);
      return {};
    },
  };

  const policyRuleV2 = {
    findMany: async ({ where }: { where: ScopeWhere }) =>
      store.rules
        .filter(
          (r) =>
            matchesScope(r, r.scope, where) &&
            (where.status === undefined || r.status === where.status) &&
            (where.source === undefined || r.source === where.source) &&
            (where.id === undefined || r.id === where.id),
        )
        .map((r) => ({
          id: r.id,
          logicalId: r.logicalId,
          name: r.name,
          enabled: r.enabled,
          priority: 1,
          action: "block",
          targets: [{ hostPattern: r.hostPattern }],
        })),
    findFirst: async ({ where }: { where: ScopeWhere }) => {
      const row = store.rules.find(
        (r) =>
          matchesScope(r, r.scope, where) &&
          (where.status === undefined || r.status === where.status) &&
          (where.source === undefined || r.source === where.source) &&
          (where.id === undefined || r.id === where.id),
      );
      return row ? { id: row.id, logicalId: row.logicalId } : null;
    },
    aggregate: async () => ({ _max: { generation: null } }),
    updateMany: async ({
      where,
      data,
    }: {
      where: ScopeWhere;
      data: { enabled?: boolean };
    }) => {
      const logicalId =
        typeof where.logicalId === "string" ? where.logicalId : undefined;
      const rows = store.rules.filter(
        (r) =>
          matchesScope(r, r.scope, where) &&
          (logicalId === undefined || r.logicalId === logicalId),
      );
      for (const r of rows) Object.assign(r, data);
      return { count: rows.length };
    },
    deleteMany: async ({ where }: { where: ScopeWhere }) => {
      const ids =
        where.logicalId && typeof where.logicalId === "object"
          ? where.logicalId.in
          : [];
      const before = store.rules.length;
      store.rules = store.rules.filter(
        (r) => !(matchesScope(r, r.scope, where) && ids.includes(r.logicalId)),
      );
      return { count: before - store.rules.length };
    },
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
    appConfig,
    appConnection: {
      count: async ({ where }: { where: ScopeWhere }) =>
        store.connections.filter(
          (c) =>
            (where.appConfigId === undefined ||
              c.appConfigId === where.appConfigId) &&
            (where.provider === undefined || c.provider === where.provider) &&
            (where.appConfigId !== undefined
              ? where.scope === undefined || c.scope === where.scope
              : matchesScope(c, c.scope, where)),
        ).length,
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 }),
    },
    policyRuleV2,
    auditLog: {
      create: async ({ data }: { data: AuditRow }) => {
        store.audits.push(data);
        return data;
      },
    },
    $transaction: async (arg: unknown) => {
      if (typeof arg === "function") {
        return (arg as (tx: unknown) => Promise<unknown>)({
          $executeRaw: async () => 0,
          policyRuleV2,
        });
      }
      return Promise.all(arg as Promise<unknown>[]);
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

const asAdmin = { headers: { Authorization: `Bearer ${ADMIN_KEY}` } };
const asOtherAdmin = {
  headers: { Authorization: `Bearer ${OTHER_ADMIN_KEY}` },
};
const asProjectKey = { headers: { Authorization: `Bearer ${PROJECT_KEY}` } };

const json = (init: RequestInit, body: unknown): RequestInit => ({
  ...init,
  headers: {
    ...(init.headers as Record<string, string>),
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});

interface ConfigStatus {
  settings?: Record<string, string>;
  hasCredentials: boolean;
  enabled: boolean;
  source?: string;
  dependents?: { orgConnections: number; projectConnections: number };
}

interface BlocklistState {
  hostId: string;
  ruleId: string | null;
  enabled: boolean;
  scope: string | null;
}

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
  store.configs = [
    {
      id: "cfg-org",
      scope: "organization",
      projectId: null,
      organizationId: ORG,
      provider: CONFIGURABLE,
      enabled: true,
      credentials: "enc",
      settings: { clientId: "org-client" },
    },
    // A PROJECT config in the same org — must never surface on /v1/org/apps.
    {
      id: "cfg-project",
      scope: "project",
      projectId: PROJECT,
      organizationId: null,
      provider: "notion",
      enabled: true,
      credentials: "enc",
      settings: { clientId: "proj-client" },
    },
    {
      id: "cfg-foreign",
      scope: "organization",
      projectId: null,
      organizationId: OTHER_ORG,
      provider: "gitlab",
      enabled: true,
      credentials: "enc",
      settings: {},
    },
  ];
  store.connections = [
    // Two org connections on the org config, plus one project connection it
    // minted — the `dependents` blast radius.
    {
      id: "conn-org-1",
      scope: "organization",
      projectId: null,
      organizationId: ORG,
      appConfigId: "cfg-org",
      provider: CONFIGURABLE,
    },
    {
      id: "conn-org-2",
      scope: "organization",
      projectId: null,
      organizationId: ORG,
      appConfigId: "cfg-org",
      provider: CONFIGURABLE,
    },
    {
      id: "conn-project",
      scope: "project",
      projectId: PROJECT,
      organizationId: null,
      appConfigId: "cfg-org",
      provider: CONFIGURABLE,
    },
  ];
  store.rules = [
    {
      id: "rule-org",
      scope: "organization",
      projectId: null,
      organizationId: ORG,
      status: "draft",
      generation: 0,
      source: "blocklist",
      logicalId: "log-org",
      name: "Block npm Registry",
      enabled: true,
      hostPattern: NPM_HOST,
    },
    // A PROJECT blocklist rule on the same host — unreachable from org scope.
    {
      id: "rule-project",
      scope: "project",
      projectId: PROJECT,
      organizationId: null,
      status: "draft",
      generation: 0,
      source: "blocklist",
      logicalId: "log-project",
      name: "Block npm Registry",
      enabled: true,
      hostPattern: NPM_HOST,
    },
  ];
  store.audits = [];
  store.sessionUserId = null;
  store.seq = 100;
});

describe("GET /v1/org/apps/configured", () => {
  it("lists the ORG's enabled providers only — never project configs", async () => {
    const res = await app.request("/v1/org/apps/configured", asAdmin);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([CONFIGURABLE]);
  });

  it("isolates orgs", async () => {
    const res = await app.request("/v1/org/apps/configured", asOtherAdmin);
    expect(await res.json()).toEqual(["gitlab"]);
  });

  it("ignores an X-Project-Id the browser always attaches", async () => {
    const res = await app.request("/v1/org/apps/configured", {
      headers: {
        Authorization: `Bearer ${ADMIN_KEY}`,
        "X-Project-Id": PROJECT,
      },
    });
    expect(await res.json()).toEqual([CONFIGURABLE]);
  });
});

describe("GET /v1/org/apps/:provider/config", () => {
  it("returns the org row plus the removal blast radius", async () => {
    const res = await app.request(
      `/v1/org/apps/${CONFIGURABLE}/config`,
      asAdmin,
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as ConfigStatus).toEqual({
      settings: { clientId: "org-client" },
      hasCredentials: true,
      enabled: true,
      // R6: removing this config disconnects its own org connections AND every
      // project connection it minted, so the endpoint must report both.
      dependents: { orgConnections: 2, projectConnections: 1 },
    });
  });

  it("returns the no-config sentinel (still with dependents) for an unconfigured provider", async () => {
    const res = await app.request("/v1/org/apps/notion/config", asAdmin);
    expect((await res.json()) as ConfigStatus).toEqual({
      hasCredentials: false,
      enabled: false,
      dependents: { orgConnections: 0, projectConnections: 0 },
    });
  });

  it("never reports another org's config", async () => {
    const res = await app.request("/v1/org/apps/gitlab/config", asAdmin);
    expect(((await res.json()) as ConfigStatus).hasCredentials).toBe(false);
  });
});

describe("config writes", () => {
  it("POST creates an ORGANIZATION-scoped config and audits it against the org", async () => {
    const res = await app.request(
      "/v1/org/apps/gitlab/config",
      json(
        { ...asAdmin, method: "POST" },
        {
          clientId: "new-id",
          clientSecret: "new-secret",
        },
      ),
    );
    expect(res.status).toBe(201);
    const row = store.configs.find(
      (c) => c.organizationId === ORG && c.provider === "gitlab",
    )!;
    expect(row.scope).toBe("organization");
    expect(row.projectId).toBeNull();
    // The foreign org's gitlab config is untouched — the composite key picked
    // the caller's org, not the provider alone.
    expect(store.configs.find((c) => c.id === "cfg-foreign")!.settings).toEqual(
      {},
    );
    expect(store.audits).toEqual([
      expect.objectContaining({
        organizationId: ORG,
        userId: ADMIN,
        action: "update",
        service: "app-config",
        source: "api",
        metadata: { provider: "gitlab" },
      }),
    ]);
    expect(store.audits[0]!.projectId).toBeUndefined();
  });

  it("PATCH toggle flips the org row and audits it against the org", async () => {
    const res = await app.request(
      `/v1/org/apps/${CONFIGURABLE}/config/toggle`,
      json({ ...asAdmin, method: "PATCH" }, { enabled: false }),
    );
    expect(res.status).toBe(200);
    expect(store.configs.find((c) => c.id === "cfg-org")!.enabled).toBe(false);
    expect(store.audits[0]).toEqual(
      expect.objectContaining({
        organizationId: ORG,
        action: "update",
        service: "app-config",
        metadata: { provider: CONFIGURABLE, enabled: false },
      }),
    );
  });

  it("DELETE removes the org row and audits it against the org", async () => {
    const res = await app.request(`/v1/org/apps/${CONFIGURABLE}/config`, {
      ...asAdmin,
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(store.configs.map((c) => c.id)).not.toContain("cfg-org");
    expect(store.audits[0]).toEqual(
      expect.objectContaining({
        organizationId: ORG,
        action: "delete",
        service: "app-config",
        metadata: { provider: CONFIGURABLE },
      }),
    );
  });

  it("404s a DELETE for a provider the org has no config for", async () => {
    const res = await app.request("/v1/org/apps/notion/config", {
      ...asAdmin,
      method: "DELETE",
    });
    // The project's notion config must not be reachable from here.
    expect(res.status).toBe(404);
    expect(store.configs.map((c) => c.id)).toContain("cfg-project");
  });

  it("400s a provider that does not support app configuration", async () => {
    const res = await app.request(
      `/v1/org/apps/${BLOCKLIST_APP}/config`,
      json({ ...asAdmin, method: "POST" }, { clientId: "x" }),
    );
    expect(res.status).toBe(400);
  });
});

describe("blocklist", () => {
  it("reports the ORG's own rules — never the project's rule on the same host", async () => {
    const res = await app.request(
      `/v1/org/apps/${BLOCKLIST_APP}/blocklist`,
      asAdmin,
    );
    expect(res.status).toBe(200);
    const states = (await res.json()) as BlocklistState[];
    expect(states.find((s) => s.hostId === "npm")).toEqual(
      expect.objectContaining({
        ruleId: "rule-org",
        enabled: true,
        scope: "organization",
      }),
    );
    // The app's other declared host has no rule at org scope.
    expect(states.find((s) => s.hostId === "pypi")).toEqual(
      expect.objectContaining({ ruleId: null, enabled: false, scope: null }),
    );
  });

  it("toggles the org's own rule", async () => {
    const res = await app.request(
      `/v1/org/apps/${BLOCKLIST_APP}/blocklist/rule-org`,
      json({ ...asAdmin, method: "PATCH" }, { enabled: false }),
    );
    expect(res.status).toBe(200);
    expect(store.rules.find((r) => r.id === "rule-org")!.enabled).toBe(false);
  });

  it("404s the PROJECT's rule — an org router can't reach across scopes", async () => {
    const res = await app.request(
      `/v1/org/apps/${BLOCKLIST_APP}/blocklist/rule-project`,
      json({ ...asAdmin, method: "PATCH" }, { enabled: false }),
    );
    expect(res.status).toBe(404);
    expect(store.rules.find((r) => r.id === "rule-project")!.enabled).toBe(
      true,
    );
  });

  it("DELETE removes only the org's rule", async () => {
    const res = await app.request(
      `/v1/org/apps/${BLOCKLIST_APP}/blocklist/rule-org`,
      { ...asAdmin, method: "DELETE" },
    );
    expect(res.status).toBe(204);
    expect(store.rules.map((r) => r.id)).toEqual(["rule-project"]);
  });
});

describe("authorization", () => {
  it("403s every verb for a non-admin member session", async () => {
    store.sessionUserId = MEMBER;
    const asMember: RequestInit = {};
    const responses = await Promise.all([
      app.request("/v1/org/apps/configured", asMember),
      app.request(`/v1/org/apps/${CONFIGURABLE}/config`, asMember),
      app.request(
        `/v1/org/apps/${CONFIGURABLE}/config`,
        json({ method: "POST" }, { clientId: "x", clientSecret: "y" }),
      ),
      app.request(`/v1/org/apps/${CONFIGURABLE}/config`, {
        method: "DELETE",
      }),
      app.request(`/v1/org/apps/${BLOCKLIST_APP}/blocklist`, asMember),
    ]);
    expect(responses.map((r) => r.status)).toEqual([403, 403, 403, 403, 403]);
    expect(store.configs.map((c) => c.id)).toContain("cfg-org");
  });

  it("403s a PROJECT-scoped key even when its holder is an org owner", async () => {
    expect(
      (await app.request("/v1/org/apps/configured", asProjectKey)).status,
    ).toBe(403);
    expect(
      (
        await app.request(`/v1/org/apps/${CONFIGURABLE}/config`, {
          ...asProjectKey,
          method: "DELETE",
        })
      ).status,
    ).toBe(403);
  });

  it("401s an unauthenticated caller", async () => {
    expect((await app.request("/v1/org/apps/configured")).status).toBe(401);
  });
});

describe("the PROJECT surface is unchanged", () => {
  const asProject = {
    headers: {
      Authorization: `Bearer ${PROJECT_KEY}`,
      "X-Project-Id": PROJECT,
    },
  };

  it("GET /v1/apps/configured still lists the project's own providers", async () => {
    const res = await app.request("/v1/apps/configured", asProject);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(["notion"]);
  });

  it("GET /v1/apps/:provider/config keeps its shape — no dependents field", async () => {
    const res = await app.request("/v1/apps/notion/config", asProject);
    expect((await res.json()) as ConfigStatus).toEqual({
      settings: { clientId: "proj-client" },
      hasCredentials: true,
      enabled: true,
    });
  });

  it("GET /v1/apps/:provider still resolves — the extracted routes don't shadow it", async () => {
    // Route ORDER: `/configured` and the `/:provider/config*` handlers are
    // registered from one call now, ahead of the `/:provider` param route.
    // A single-segment path can't be swallowed by a two-segment one, and this
    // pins that.
    const res = await app.request("/v1/apps/notion", asProject);
    expect(res.status).toBe(200);
    expect((await res.json()) as { id: string }).toEqual(
      expect.objectContaining({ id: "notion" }),
    );
  });

  it("the project blocklist still shows the inherited ORG block, locked", async () => {
    // The project router's two-key read scope is what surfaces an org-level
    // block in a project, and the org arm overrides the project's own view.
    const res = await app.request(
      `/v1/apps/${BLOCKLIST_APP}/blocklist`,
      asProject,
    );
    const states = (await res.json()) as BlocklistState[];
    expect(states.find((s) => s.hostId === "npm")).toEqual(
      expect.objectContaining({ ruleId: "rule-org", scope: "organization" }),
    );
  });
});
