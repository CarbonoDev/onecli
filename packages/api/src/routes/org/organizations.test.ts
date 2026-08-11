import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../../types";

// `/v1/organizations` end-to-end through the real app: the OSS org routes
// mounted on the `eeRoutes` seam, the OSS role resolver wired as the
// RoleResolver, and `CAPS.rbac` on. Admin callers arrive with an org API key
// (whose key path re-checks admin through the resolver); the non-admin cases
// use a session, since a non-admin's org key fails key authentication
// outright. (Same harness as invitations.test.ts — cloned, not shared.)
//
// The router carries no `role` filter — `GET /` is deliberately member-visible
// — so the write's admin gate is per-resource (`requireOrgAdmin`). That split
// is what most of the guard-stack cases below are checking.

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

interface OrgRow {
  id: string;
  name: string;
  slug: string;
}

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
  organizations: [] as OrgRow[],
  members: [] as MemberRow[],
  users: [] as UserRow[],
  audits: [] as AuditRow[],
  /** Which user the session provider resolves to (null = no session). */
  sessionUserId: null as string | null,
}));

vi.mock("@onecli/db", () => {
  // The subset of the Prisma `where` shapes these routes actually build.
  interface MemberKey {
    organizationId_userId: { organizationId: string; userId: string };
  }
  interface OrgWhere {
    id?: string;
  }

  const findMember = (organizationId: string, userId: string) =>
    store.members.find(
      (row) => row.organizationId === organizationId && row.userId === userId,
    );

  return {
    Prisma: { JsonNull: null },
    db: {
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
            return { userId: OWNER, projectId: "proj-1" };
          return null;
        },
        findFirst: async () => null,
        // The gateway-cache flush `withAudit` fires on an org-scoped write.
        findMany: async () => [],
      },
      user: {
        findUnique: async ({
          where,
        }: {
          where: { id?: string; externalAuthId?: string; email?: string };
        }) =>
          store.users.find(
            (u) =>
              (where.id !== undefined && u.id === where.id) ||
              (where.externalAuthId !== undefined &&
                u.externalAuthId === where.externalAuthId) ||
              (where.email !== undefined && u.email === where.email),
          ) ?? null,
      },
      organization: {
        findUnique: async ({
          where,
          select,
        }: {
          where: OrgWhere;
          select?: Partial<Record<keyof OrgRow, boolean>>;
        }) => {
          const row = store.organizations.find((o) => o.id === where.id);
          if (!row) return null;
          if (!select) return row;
          const picked: Record<string, unknown> = {};
          for (const key of Object.keys(select) as (keyof OrgRow)[]) {
            if (select[key]) picked[key] = row[key];
          }
          return picked;
        },
        // Mirrors Prisma's partial update: only the keys `data` carries are
        // written, so a route that leaked `slug` into `data` would show up
        // here as a changed slug rather than being silently absorbed.
        updateMany: async ({
          where,
          data,
        }: {
          where: OrgWhere;
          data: Partial<OrgRow>;
        }) => {
          const rows = store.organizations.filter((o) => o.id === where.id);
          for (const row of rows) Object.assign(row, data);
          return { count: rows.length };
        },
      },
      organizationMember: {
        findUnique: async ({ where }: { where: MemberKey }) => {
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
        // listUserOrganizations: active memberships joined to their org.
        findMany: async ({
          where,
        }: {
          where: { userId: string; status?: { not?: string } };
        }) =>
          store.members
            .filter(
              (row) =>
                row.userId === where.userId &&
                !(
                  where.status?.not !== undefined &&
                  row.status === where.status.not
                ),
            )
            .slice()
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            .map((row) => {
              const org = store.organizations.find(
                (o) => o.id === row.organizationId,
              );
              return {
                role: row.role,
                organization: {
                  id: row.organizationId,
                  name: org?.name ?? "",
                  slug: org?.slug ?? "",
                },
              };
            }),
        count: async () => 0,
      },
      project: {
        findFirst: async () => ({ id: "proj-1", organizationId: ORG }),
        findUnique: async () => ({ id: "proj-1", organizationId: ORG }),
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
  createdAt,
});

beforeEach(() => {
  store.organizations = [
    { id: ORG, name: "Acme", slug: "acme" },
    { id: OTHER_ORG, name: "Foreign", slug: "foreign" },
  ];
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
  ];
  store.members = [
    member(OWNER, "owner", at(0)),
    member(ADMIN, "admin", at(1)),
    member(MEMBER, "member", at(2)),
    // The same admin is an owner of the OTHER org — so a cross-org PATCH is
    // rejected by the fence, not merely by an absent membership.
    member(ADMIN, "owner", at(3), OTHER_ORG),
  ];
  store.audits = [];
  store.sessionUserId = null;
});

const orgRow = (id: string) => store.organizations.find((o) => o.id === id);

const asAdmin = { headers: { Authorization: `Bearer ${ADMIN_KEY}` } };
const asProjectKey = { headers: { Authorization: `Bearer ${PROJECT_KEY}` } };

const patch = (id: string, body: unknown, init: RequestInit = asAdmin) =>
  app.request(`/v1/organizations/${id}`, {
    ...init,
    method: "PATCH",
    body: JSON.stringify(body),
  });

interface OrganizationBody {
  id: string;
  name: string;
  slug: string;
  role?: string;
}

describe("guard stack", () => {
  it("401s an unauthenticated caller on both routes", async () => {
    expect((await app.request("/v1/organizations")).status).toBe(401);
    expect((await patch(ORG, { name: "Hijacked" }, {})).status).toBe(401);
    expect(orgRow(ORG)?.name).toBe("Acme");
    expect(store.audits).toHaveLength(0);
  });

  it("403s a project-scoped key on both routes, even when its user is an org owner", async () => {
    expect((await app.request("/v1/organizations", asProjectKey)).status).toBe(
      403,
    );
    expect((await patch(ORG, { name: "Hijacked" }, asProjectKey)).status).toBe(
      403,
    );
    expect(orgRow(ORG)?.name).toBe("Acme");
    expect(store.audits).toHaveLength(0);
  });

  it("rejects a suspended admin's org key (suspended reads as no role)", async () => {
    const row = store.members.find(
      (m) => m.userId === ADMIN && m.organizationId === ORG,
    );
    if (row) row.status = "suspended";
    // The key path fails first, so this is a 401 rather than the 403 a
    // suspended session would get.
    expect((await patch(ORG, { name: "Hijacked" })).status).toBe(401);
    expect(orgRow(ORG)?.name).toBe("Acme");
    expect(store.audits).toHaveLength(0);
  });
});

describe("GET /v1/organizations", () => {
  it("returns the caller's active memberships with their role", async () => {
    const res = await app.request("/v1/organizations", asAdmin);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { id: ORG, name: "Acme", slug: "acme", role: "admin" },
      { id: OTHER_ORG, name: "Foreign", slug: "foreign", role: "owner" },
    ]);
  });

  it("200s a plain member — the list is deliberately not admin-gated", async () => {
    store.sessionUserId = MEMBER;
    const res = await app.request("/v1/organizations");
    expect(res.status).toBe(200);
    const body = (await res.json()) as OrganizationBody[];
    expect(body.map((row) => row.id)).toEqual([ORG]);
  });

  it("never audits a read", async () => {
    await app.request("/v1/organizations", asAdmin);
    expect(store.audits).toHaveLength(0);
  });
});

describe("PATCH /v1/organizations/:organizationId", () => {
  it("renames, returns the row, and audits with organizationId and NO projectId", async () => {
    const res = await patch(ORG, { name: "Acme Prime" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: ORG,
      name: "Acme Prime",
      slug: "acme",
    });
    expect(orgRow(ORG)?.name).toBe("Acme Prime");
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({
      organizationId: ORG,
      userId: ADMIN,
      action: "update",
      service: "organization",
      source: "api",
      metadata: { organizationId: ORG, change: "name", name: "Acme Prime" },
    });
    expect(store.audits[0]?.projectId).toBeUndefined();
  });

  it("200s an owner arriving with a session", async () => {
    store.sessionUserId = OWNER;
    const res = await patch(ORG, { name: "Owned" }, {});
    expect(res.status).toBe(200);
    expect(orgRow(ORG)?.name).toBe("Owned");
    expect(store.audits[0]).toMatchObject({ userId: OWNER, action: "update" });
  });

  it("trims the name before storing", async () => {
    const res = await patch(ORG, { name: "  Padded  " });
    expect(res.status).toBe(200);
    expect(orgRow(ORG)?.name).toBe("Padded");
    expect(((await res.json()) as OrganizationBody).name).toBe("Padded");
  });

  it("never writes slug, not even when the body carries one", async () => {
    await patch(ORG, { name: "Acme Prime", slug: "hijacked" });
    expect(orgRow(ORG)?.slug).toBe("acme");
  });

  it("422s an empty / whitespace-only / overlong / missing name", async () => {
    for (const body of [
      { name: "" },
      { name: "   " },
      { name: "x".repeat(256) },
      {},
    ]) {
      expect((await patch(ORG, body)).status).toBe(422);
    }
    expect(orgRow(ORG)?.name).toBe("Acme");
    expect(store.audits).toHaveLength(0);
  });

  it("422s a non-string name rather than coercing it", async () => {
    // `{ name: 123 }` would stringify to "123" under a coercing schema — a
    // silent rename to a number. Zod rejects the type outright.
    const res = await patch(ORG, { name: 123 });
    expect(res.status).toBe(422);
    expect(orgRow(ORG)?.name).toBe("Acme");
    expect(store.audits).toHaveLength(0);
  });

  it("422s an unparseable body rather than 500ing", async () => {
    const res = await app.request(`/v1/organizations/${ORG}`, {
      ...asAdmin,
      method: "PATCH",
    });
    expect(res.status).toBe(422);
    expect(store.audits).toHaveLength(0);
  });

  it("permits a rename-to-self as a 200 no-op", async () => {
    const res = await patch(ORG, { name: "Acme" });
    expect(res.status).toBe(200);
    expect(orgRow(ORG)?.name).toBe("Acme");
  });

  it("lets two organizations share a name — names are not unique", async () => {
    const res = await patch(ORG, { name: "Foreign" });
    expect(res.status).toBe(200);
    expect(orgRow(ORG)?.name).toBe("Foreign");
    expect(orgRow(OTHER_ORG)?.name).toBe("Foreign");
  });

  it("404s another organization's id even when the caller owns it there", async () => {
    const res = await patch(OTHER_ORG, { name: "Captured" });
    expect(res.status).toBe(404);
    expect(orgRow(OTHER_ORG)?.name).toBe("Foreign");
    expect(store.audits).toHaveLength(0);
  });

  it("404s an unknown organization id", async () => {
    expect((await patch("org-nope", { name: "X" })).status).toBe(404);
    expect(store.audits).toHaveLength(0);
  });

  it("403s a plain member and writes/audits nothing", async () => {
    store.sessionUserId = MEMBER;
    const res = await patch(ORG, { name: "Nope" }, {});
    expect(res.status).toBe(403);
    expect(orgRow(ORG)?.name).toBe("Acme");
    expect(store.audits).toHaveLength(0);
  });

  it("401s a suspended owner's session (suspended reads as no role)", async () => {
    const row = store.members.find(
      (m) => m.userId === OWNER && m.organizationId === ORG,
    );
    if (row) row.status = "suspended";
    store.sessionUserId = OWNER;
    expect((await patch(ORG, { name: "Nope" }, {})).status).toBe(401);
    expect(orgRow(ORG)?.name).toBe("Acme");
    expect(store.audits).toHaveLength(0);
  });
});
