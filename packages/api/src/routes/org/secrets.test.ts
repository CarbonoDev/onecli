import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../../types";

// `/v1/org/secrets` end-to-end through the real app: OSS org routes on the
// `eeRoutes` seam, the OSS role resolver, admin callers with an ORG API key.
// Same harness shape as policy.test.ts / budgets.test.ts (cloned, not shared)
// with an in-memory secret store — the point of this router is which SCOPE (and
// which org) the shared secret handlers read and write in, so the mock
// implements `scopeWhere`/`scopeCreate`/`scopeOwnership` faithfully rather than
// answering every query with the whole table.

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

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "oss";
  // 32 zero bytes, base64 — `lib/crypto` rejects anything else, and creating a
  // secret encrypts its value for real here.
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

interface SecretRow {
  id: string;
  scope: string;
  projectId: string | null;
  organizationId: string | null;
  name: string;
  type: string;
  valueSource: string;
  encryptedValue: string | null;
  opRef: string | null;
  hostPattern: string;
  pathPattern: string | null;
  injectionConfig: unknown;
  metadata: unknown;
  createdAt: Date;
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

/** The `scopeWhere` / `scopeOwnership` shapes the secret service builds. */
interface ScopeWhere {
  id?: string;
  projectId?: string;
  organizationId?: string;
  scope?: string;
  OR?: { projectId?: string; organizationId?: string; scope?: string }[];
}

const store = vi.hoisted(() => ({
  members: [] as MemberRow[],
  users: [] as UserRow[],
  secrets: [] as SecretRow[],
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

  // Faithful evaluation of the `scopeWhere`/`scopeOwnership` predicates: a bare
  // conjunction, or the two-arm OR the project scope builds. Getting this wrong
  // would make the cross-scope tests below pass for the wrong reason.
  const arm = (
    row: SecretRow,
    w: { projectId?: string; organizationId?: string; scope?: string },
  ) =>
    (w.projectId === undefined || row.projectId === w.projectId) &&
    (w.organizationId === undefined ||
      row.organizationId === w.organizationId) &&
    (w.scope === undefined || row.scope === w.scope);

  const matches = (row: SecretRow, where: ScopeWhere) => {
    if (where.id !== undefined && row.id !== where.id) return false;
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
        // A PROJECT-scoped key owned by the org's OWNER — authenticates fine,
        // which is exactly why the router needs its own scope guard.
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
    secret: {
      findMany: async ({ where }: { where: ScopeWhere }) =>
        store.secrets
          .filter((s) => matches(s, where))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      findFirst: async ({ where }: { where: ScopeWhere }) =>
        store.secrets.find((s) => matches(s, where)) ?? null,
      create: async ({ data }: { data: Partial<SecretRow> }) => {
        const row: SecretRow = {
          id: nextId("sec"),
          scope: "project",
          projectId: null,
          organizationId: null,
          name: "",
          type: "generic",
          valueSource: "inline",
          encryptedValue: null,
          opRef: null,
          hostPattern: "",
          pathPattern: null,
          injectionConfig: null,
          metadata: null,
          createdAt: new Date(),
          ...data,
        };
        store.secrets.push(row);
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<SecretRow>;
      }) => {
        const row = store.secrets.find((s) => s.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        store.secrets = store.secrets.filter((s) => s.id !== where.id);
        return {};
      },
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

const secret = (id: string, overrides: Partial<SecretRow> = {}): SecretRow => ({
  id,
  scope: "organization",
  projectId: null,
  organizationId: ORG,
  name: id,
  type: "generic",
  valueSource: "inline",
  encryptedValue: "enc",
  opRef: null,
  hostPattern: "api.example.com",
  pathPattern: null,
  injectionConfig: { headerName: "X-Key", valueFormat: "{value}" },
  metadata: null,
  createdAt: at(1),
  ...overrides,
});

const asAdmin = { headers: { Authorization: `Bearer ${ADMIN_KEY}` } };
const asOtherAdmin = {
  headers: { Authorization: `Bearer ${OTHER_ADMIN_KEY}` },
};
const asProjectKey = { headers: { Authorization: `Bearer ${PROJECT_KEY}` } };

interface SecretBody {
  id: string;
  name: string;
  scope?: string;
}

const json = (init: RequestInit, body: unknown): RequestInit => ({
  ...init,
  method: init.method,
  headers: {
    ...(init.headers as Record<string, string>),
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});

const listOrg = async (init: RequestInit = asAdmin) => {
  const res = await app.request("/v1/org/secrets", init);
  expect(res.status).toBe(200);
  return (await res.json()) as SecretBody[];
};

const create = (body: unknown, init: RequestInit = asAdmin) =>
  app.request("/v1/org/secrets", json({ ...init, method: "POST" }, body));

const patch = (id: string, body: unknown, init: RequestInit = asAdmin) =>
  app.request(
    `/v1/org/secrets/${id}`,
    json({ ...init, method: "PATCH" }, body),
  );

const remove = (id: string, init: RequestInit = asAdmin) =>
  app.request(`/v1/org/secrets/${id}`, { ...init, method: "DELETE" });

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
  store.secrets = [
    secret("s-org"),
    secret("s-org-2", { name: "second", createdAt: at(2) }),
    // A PROJECT-scoped secret in the SAME org — must never appear on the org
    // surface, and must not be reachable by an org-scope write.
    secret("s-project", {
      scope: "project",
      projectId: PROJECT,
      organizationId: null,
    }),
    // Another org's org-scoped secret.
    secret("s-foreign", { organizationId: OTHER_ORG }),
  ];
  store.audits = [];
  store.sessionUserId = null;
  store.seq = 100;
});

describe("GET /v1/org/secrets", () => {
  it("returns the caller's ORG secrets only — never project rows", async () => {
    const body = await listOrg();
    expect(body.map((s) => s.id).sort()).toEqual(["s-org", "s-org-2"]);
  });

  it("isolates orgs", async () => {
    const body = await listOrg(asOtherAdmin);
    expect(body.map((s) => s.id)).toEqual(["s-foreign"]);
  });

  it("ignores an X-Project-Id the browser always attaches", async () => {
    // `apiFetch` sends the project header whenever the cookie exists, so the
    // auth context here carries BOTH ids. A two-key scope would OR the
    // project's own rows back in — the cross-scope leak this router must not
    // have.
    const body = await listOrg({
      headers: {
        Authorization: `Bearer ${ADMIN_KEY}`,
        "X-Project-Id": PROJECT,
      },
    });
    expect(body.map((s) => s.id).sort()).toEqual(["s-org", "s-org-2"]);
  });
});

describe("POST /v1/org/secrets", () => {
  it("creates an ORGANIZATION-scoped secret and audits it against the org", async () => {
    const res = await create({
      name: "Datadog",
      type: "generic",
      value: "dd-key",
      hostPattern: "api.datadoghq.com",
      injectionConfig: { headerName: "DD-API-KEY" },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as SecretBody;

    const row = store.secrets.find((s) => s.id === created.id)!;
    expect(row.scope).toBe("organization");
    expect(row.organizationId).toBe(ORG);
    expect(row.projectId).toBeNull();

    // The flush key: `withAudit` keys `invalidateGatewayCacheForOrg` off
    // `organizationId`, so its absence would leave a deleted org secret
    // injecting for a cache window.
    expect(store.audits).toEqual([
      expect.objectContaining({
        organizationId: ORG,
        userId: ADMIN,
        action: "create",
        service: "secret",
        source: "api",
      }),
    ]);
    // No project key on the audit row — that would flush (and attribute) the
    // wrong scope.
    expect(store.audits[0]!.projectId).toBeUndefined();
  });

  it("rejects a 1Password-backed value at org scope with its written-out reason", async () => {
    const res = await create({
      name: "From 1P",
      type: "anthropic",
      valueSource: "onepassword",
      opRef: "op://vault/item/field",
      hostPattern: "api.anthropic.com",
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { message: string } }).toEqual({
      error: {
        message: "1Password is only available for project-scoped secrets",
        type: "invalid_request_error",
      },
    });
    expect(store.audits).toEqual([]);
  });
});

describe("PATCH / DELETE /v1/org/secrets/:id", () => {
  it("updates an org secret and audits it against the org", async () => {
    const res = await patch("s-org", { name: "renamed" });
    expect(res.status).toBe(200);
    expect(store.secrets.find((s) => s.id === "s-org")!.name).toBe("renamed");
    expect(store.audits).toEqual([
      expect.objectContaining({
        organizationId: ORG,
        action: "update",
        service: "secret",
        metadata: { secretId: "s-org" },
      }),
    ]);
  });

  it("deletes an org secret and audits it against the org", async () => {
    const res = await remove("s-org");
    expect(res.status).toBe(204);
    expect(store.secrets.map((s) => s.id)).not.toContain("s-org");
    expect(store.audits).toEqual([
      expect.objectContaining({
        organizationId: ORG,
        action: "delete",
        service: "secret",
        metadata: { secretId: "s-org" },
      }),
    ]);
  });

  it("404s a PROJECT-scoped secret in the same org — writes can't cross scopes", async () => {
    expect((await patch("s-project", { name: "x" })).status).toBe(404);
    expect((await remove("s-project")).status).toBe(404);
    expect(store.secrets.map((s) => s.id)).toContain("s-project");
    expect(store.audits).toEqual([]);
  });

  it("404s another org's secret", async () => {
    expect((await remove("s-foreign")).status).toBe(404);
    expect(store.secrets.map((s) => s.id)).toContain("s-foreign");
  });
});

describe("authorization", () => {
  it("403s every verb for a non-admin member session", async () => {
    store.sessionUserId = MEMBER;
    const asMember: RequestInit = {};
    const responses = await Promise.all([
      app.request("/v1/org/secrets", asMember),
      create(
        { name: "x", type: "generic", value: "v", hostPattern: "h" },
        asMember,
      ),
      patch("s-org", { name: "x" }, asMember),
      remove("s-org", asMember),
    ]);
    expect(responses.map((r) => r.status)).toEqual([403, 403, 403, 403]);
    expect(store.secrets.find((s) => s.id === "s-org")!.name).toBe("s-org");
  });

  it("403s a PROJECT-scoped key even when its holder is an org owner", async () => {
    // `role` is scope-blind, so a leaked agent key belonging to an admin would
    // otherwise mint a credential every project in the org inherits.
    expect((await app.request("/v1/org/secrets", asProjectKey)).status).toBe(
      403,
    );
    expect(
      (
        await create(
          { name: "x", type: "generic", value: "v", hostPattern: "h" },
          asProjectKey,
        )
      ).status,
    ).toBe(403);
  });

  it("401s an unauthenticated caller", async () => {
    expect((await app.request("/v1/org/secrets")).status).toBe(401);
  });
});

describe("the PROJECT surface is unchanged", () => {
  it("GET /v1/secrets still inherits the org's secrets alongside its own", async () => {
    // The two-key read scope is what makes an org secret visible in every
    // project. Narrowing it would silently drop inherited credentials.
    const res = await app.request("/v1/secrets", {
      headers: {
        Authorization: `Bearer ${PROJECT_KEY}`,
        "X-Project-Id": PROJECT,
      },
    });
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as SecretBody[]).map((s) => s.id).sort(),
    ).toEqual(["s-org", "s-org-2", "s-project"]);
  });

  it("POST /v1/secrets still creates a PROJECT-scoped row", async () => {
    const res = await app.request(
      "/v1/secrets",
      json(
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${PROJECT_KEY}`,
            "X-Project-Id": PROJECT,
          },
        },
        {
          name: "Project key",
          type: "generic",
          value: "v",
          hostPattern: "api.example.com",
          injectionConfig: { headerName: "X-Key" },
        },
      ),
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as SecretBody;
    const row = store.secrets.find((s) => s.id === created.id)!;
    expect(row.scope).toBe("project");
    expect(row.projectId).toBe(PROJECT);
    expect(row.organizationId).toBeNull();
    // The project surface has never audited secret writes; this PR doesn't
    // change that.
    expect(store.audits).toEqual([]);
  });
});
