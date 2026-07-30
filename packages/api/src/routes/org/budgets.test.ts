import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../../types";

// `/v1/org/budgets` end-to-end through the real app: OSS org routes on the
// `eeRoutes` seam, the OSS role resolver, admin callers with an ORG API key.
// Same harness shape as policy.test.ts (cloned, not shared) with an in-memory
// budgets/secrets/spend store — the point of this router is which SCOPE (and
// which org) the budget CRUD writes/reads in, plus the metered-type guard.

const ORG = "org-1";
const OTHER_ORG = "org-2";
const ADMIN = "user-admin";
const OUTSIDER = "user-outsider";
const OWNER = "user-owner";
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

interface SecretRow {
  id: string;
  name: string;
  type: string;
  organizationId: string | null;
}

interface BudgetRow {
  id: string;
  secretId: string;
  organizationId: string;
  limitCents: number;
  period: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

interface SpendRow {
  secretId: string;
  organizationId: string;
  period: string;
  spentNanos: bigint;
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
  secrets: [] as SecretRow[],
  budgets: [] as BudgetRow[],
  spends: [] as SpendRow[],
  audits: [] as AuditRow[],
  seq: 0,
}));

vi.mock("@onecli/db", () => {
  class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }

  const nextId = (prefix: string) => `${prefix}-${++store.seq}`;

  const findMember = (organizationId: string, userId: string) =>
    store.members.find(
      (m) => m.organizationId === organizationId && m.userId === userId,
    );

  const secretOf = (secretId: string) => {
    const s = store.secrets.find((x) => x.id === secretId);
    return s ? { name: s.name, type: s.type } : { name: "", type: "" };
  };

  const withSecret = (b: BudgetRow) => ({ ...b, secret: secretOf(b.secretId) });

  const db = {
    apiKey: {
      findUnique: async ({ where }: { where: { key?: string } }) => {
        if (where.key === ADMIN_KEY)
          return {
            userId: ADMIN,
            organizationId: ORG,
            scope: "organization",
          };
        if (where.key === OTHER_ADMIN_KEY)
          return {
            userId: OUTSIDER,
            organizationId: OTHER_ORG,
            scope: "organization",
          };
        // A PROJECT-scoped key owned by the org's OWNER — authenticates fine,
        // which is exactly why the router needs its own scope guard.
        if (where.key === PROJECT_KEY)
          return { userId: OWNER, projectId: "proj-1" };
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
      findFirst: async () => null,
      findMany: async () => [],
    },
    project: {
      findFirst: async () => ({ id: "proj-1", organizationId: ORG }),
      findUnique: async () => ({ id: "proj-1", organizationId: ORG }),
    },
    projectAccess: { findFirst: async () => null },
    secret: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        store.secrets.find((s) => s.id === where.id) ?? null,
    },
    budget: {
      findMany: async ({ where }: { where: { organizationId: string } }) =>
        store.budgets
          .filter((b) => b.organizationId === where.organizationId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map(withSecret),
      findFirst: async ({
        where,
      }: {
        where: { id: string; organizationId: string };
      }) => {
        const b = store.budgets.find(
          (row) =>
            row.id === where.id && row.organizationId === where.organizationId,
        );
        return b ? withSecret(b) : null;
      },
      create: async ({
        data,
      }: {
        data: Omit<BudgetRow, "id" | "createdAt" | "updatedAt">;
      }) => {
        if (
          store.budgets.some(
            (b) =>
              b.secretId === data.secretId &&
              b.organizationId === data.organizationId,
          )
        ) {
          throw new PrismaClientKnownRequestError("unique", "P2002");
        }
        const now = new Date();
        const row: BudgetRow = {
          ...data,
          id: nextId("budget"),
          createdAt: now,
          updatedAt: now,
        };
        store.budgets.push(row);
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<BudgetRow>;
      }) => {
        const b = store.budgets.find((row) => row.id === where.id);
        if (!b) throw new PrismaClientKnownRequestError("missing", "P2025");
        Object.assign(b, data, { updatedAt: new Date() });
        return withSecret(b);
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const before = store.budgets.length;
        store.budgets = store.budgets.filter((row) => row.id !== where.id);
        if (store.budgets.length === before)
          throw new PrismaClientKnownRequestError("missing", "P2025");
        return {};
      },
    },
    budgetSpend: {
      findMany: async ({
        where,
      }: {
        where: {
          organizationId: string;
          secretId: { in: string[] };
          period: { in: string[] };
        };
      }) =>
        store.spends.filter(
          (s) =>
            s.organizationId === where.organizationId &&
            where.secretId.in.includes(s.secretId) &&
            where.period.in.includes(s.period),
        ),
      findFirst: async ({
        where,
      }: {
        where: {
          organizationId: string;
          secretId: string;
          period: string;
        };
      }) =>
        store.spends.find(
          (s) =>
            s.organizationId === where.organizationId &&
            s.secretId === where.secretId &&
            s.period === where.period,
        ) ?? null,
    },
    auditLog: {
      create: async ({ data }: { data: AuditRow }) => {
        store.audits.push(data);
        return data;
      },
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

const sessionProvider = { getSession: async () => null };

const app: Hono<ApiEnv> = createApiApp(sessionProvider, {
  eeRoutes: registerOssOrgRoutes,
  roleResolver: ossRoleResolver,
});

const at = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m));

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

/** Current UTC monthly key — must match the service + gateway. */
const monthlyKey = () => {
  const now = new Date();
  return `m:${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
};

beforeEach(() => {
  store.users = [
    {
      id: ADMIN,
      externalAuthId: "ext-admin",
      email: "admin@x.test",
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
    member(ADMIN, "admin", ORG),
    member(OUTSIDER, "admin", OTHER_ORG),
    member(OWNER, "owner", ORG),
  ];
  store.secrets = [
    {
      id: "sec-anthropic",
      name: "Claude",
      type: "anthropic",
      organizationId: ORG,
    },
    { id: "sec-openai", name: "GPT", type: "openai", organizationId: ORG },
    {
      id: "sec-generic",
      name: "Datadog",
      type: "generic",
      organizationId: ORG,
    },
    {
      id: "sec-foreign",
      name: "Foreign",
      type: "anthropic",
      organizationId: OTHER_ORG,
    },
  ];
  store.budgets = [
    {
      id: "b-1",
      secretId: "sec-anthropic",
      organizationId: ORG,
      limitCents: 5000,
      period: "monthly",
      createdBy: ADMIN,
      createdAt: at(1),
      updatedAt: at(1),
    },
    {
      id: "b-foreign",
      secretId: "sec-foreign",
      organizationId: OTHER_ORG,
      limitCents: 1000,
      period: "monthly",
      createdBy: OUTSIDER,
      createdAt: at(2),
      updatedAt: at(2),
    },
  ];
  store.spends = [
    // $12.34 spent this month on sec-anthropic → 1234 cents.
    {
      secretId: "sec-anthropic",
      organizationId: ORG,
      period: monthlyKey(),
      spentNanos: 12_340_000_000n,
    },
  ];
  store.audits = [];
  store.seq = 100;
});

const asAdmin = { headers: { Authorization: `Bearer ${ADMIN_KEY}` } };
const asOtherAdmin = {
  headers: { Authorization: `Bearer ${OTHER_ADMIN_KEY}` },
};
const asProjectKey = { headers: { Authorization: `Bearer ${PROJECT_KEY}` } };

interface BudgetBody {
  id: string;
  secretId: string;
  secretType: string;
  limitCents: number;
  period: string;
  spentCents: number;
}

const list = async (init: RequestInit = asAdmin): Promise<BudgetBody[]> => {
  const res = await app.request("/v1/org/budgets", init);
  expect(res.status).toBe(200);
  return (await res.json()) as BudgetBody[];
};

const create = (body: unknown, init: RequestInit = asAdmin) =>
  app.request("/v1/org/budgets", {
    ...init,
    method: "POST",
    body: JSON.stringify(body),
  });

const patch = (id: string, body: unknown, init: RequestInit = asAdmin) =>
  app.request(`/v1/org/budgets/${id}`, {
    ...init,
    method: "PATCH",
    body: JSON.stringify(body),
  });

const remove = (id: string, init: RequestInit = asAdmin) =>
  app.request(`/v1/org/budgets/${id}`, { ...init, method: "DELETE" });

describe("list + scope fencing", () => {
  it("lists the org's budgets joined with current-period spend", async () => {
    const body = await list();
    expect(body.map((b) => b.id)).toEqual(["b-1"]);
    expect(body[0]).toMatchObject({
      secretId: "sec-anthropic",
      secretType: "anthropic",
      limitCents: 5000,
      period: "monthly",
      spentCents: 1234,
    });
  });

  it("never returns another org's budgets", async () => {
    const body = await list();
    expect(body.map((b) => b.id)).not.toContain("b-foreign");
    // The other org's admin sees only its own.
    const foreign = await list(asOtherAdmin);
    expect(foreign.map((b) => b.id)).toEqual(["b-foreign"]);
  });
});

describe("create", () => {
  it("creates a budget on a metered LLM secret and audits it", async () => {
    const res = await create({ secretId: "sec-openai", limitCents: 2500 });
    expect(res.status).toBe(201);
    const created = (await res.json()) as BudgetBody;
    expect(created).toMatchObject({
      secretId: "sec-openai",
      secretType: "openai",
      limitCents: 2500,
      period: "monthly",
      spentCents: 0,
    });
    const row = store.budgets.find((b) => b.id === created.id);
    expect(row).toMatchObject({ organizationId: ORG, secretId: "sec-openai" });
    expect(store.audits.at(-1)).toMatchObject({
      organizationId: ORG,
      service: "budget",
      action: "create",
      source: "api",
    });
  });

  it("rejects a non-metered (non-LLM) secret with 400", async () => {
    const res = await create({ secretId: "sec-generic", limitCents: 2500 });
    expect(res.status).toBe(400);
    expect(store.budgets.some((b) => b.secretId === "sec-generic")).toBe(false);
  });

  it("rejects a foreign-org secret with 404", async () => {
    const res = await create({ secretId: "sec-foreign", limitCents: 2500 });
    expect(res.status).toBe(404);
  });

  it("rejects a duplicate (secret, org) budget with 409", async () => {
    const res = await create({ secretId: "sec-anthropic", limitCents: 9999 });
    expect(res.status).toBe(409);
  });

  it("rejects a non-positive cap with 422", async () => {
    const res = await create({ secretId: "sec-openai", limitCents: 0 });
    expect(res.status).toBe(422);
  });
});

describe("update + delete", () => {
  it("updates the cap and period (org-fenced)", async () => {
    const res = await patch("b-1", { limitCents: 8000, period: "total" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BudgetBody;
    expect(body).toMatchObject({ limitCents: 8000, period: "total" });
    expect(store.audits.at(-1)).toMatchObject({
      service: "budget",
      action: "update",
    });
  });

  it("404s updating another org's budget", async () => {
    const res = await patch("b-foreign", { limitCents: 8000 });
    expect(res.status).toBe(404);
  });

  it("deletes an org budget", async () => {
    const res = await remove("b-1");
    expect(res.status).toBe(204);
    expect(store.budgets.some((b) => b.id === "b-1")).toBe(false);
    expect(store.audits.at(-1)).toMatchObject({
      service: "budget",
      action: "delete",
    });
  });

  it("404s deleting another org's budget", async () => {
    const res = await remove("b-foreign");
    expect(res.status).toBe(404);
    expect(store.budgets.some((b) => b.id === "b-foreign")).toBe(true);
  });
});

describe("credential scope guard", () => {
  it("403s a project-scoped credential on every method", async () => {
    expect((await app.request("/v1/org/budgets", asProjectKey)).status).toBe(
      403,
    );
    expect(
      (await create({ secretId: "sec-openai", limitCents: 1 }, asProjectKey))
        .status,
    ).toBe(403);
    expect((await patch("b-1", { limitCents: 1 }, asProjectKey)).status).toBe(
      403,
    );
    expect((await remove("b-1", asProjectKey)).status).toBe(403);
  });
});
