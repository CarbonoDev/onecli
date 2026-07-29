import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../../types";

// `/v1/org/invitations` end-to-end through the real app: the OSS org routes
// mounted on the `eeRoutes` seam, the OSS role resolver wired as the
// RoleResolver, and `CAPS.rbac` on. Admin callers arrive with an org API key
// (whose key path re-checks admin through the resolver); the non-admin cases
// use a session, since a non-admin's org key fails key authentication
// outright. (Same harness as members.test.ts.)

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

interface InvitationRow {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  token: string;
  status: string;
  invitedById: string;
  invitedByEmail: string;
  expiresAt: Date;
  createdAt: Date;
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
  invitations: [] as InvitationRow[],
  audits: [] as AuditRow[],
  seq: 0,
  /** Which user the session provider resolves to (null = no session). */
  sessionUserId: null as string | null,
}));

vi.mock("@onecli/db", () => {
  // The subset of the Prisma `where` shapes these routes actually build.
  interface InvitationWhere {
    id?: string;
    organizationId?: string;
    status?: string;
    email?: { contains: string };
    /** The keyset predicate — the service nests it under AND, never top-level. */
    AND?: {
      OR: { createdAt?: Date | { gt?: Date }; id?: { gt: string } }[];
    }[];
  }
  interface InvitationKey {
    organizationId_email?: { organizationId: string; email: string };
    token?: string;
  }
  interface MemberKey {
    organizationId_userId: { organizationId: string; userId: string };
  }

  const matchesCursor = (
    row: InvitationRow,
    filter: InvitationWhere["AND"],
  ) => {
    if (!filter) return true;
    return filter.every((conjunct) =>
      conjunct.OR.some((clause) => {
        if (clause.createdAt instanceof Date) {
          return (
            row.createdAt.getTime() === clause.createdAt.getTime() &&
            clause.id !== undefined &&
            row.id > clause.id.gt
          );
        }
        const gt = clause.createdAt?.gt;
        return gt !== undefined && row.createdAt.getTime() > gt.getTime();
      }),
    );
  };

  const filterInvitations = (where: InvitationWhere) =>
    store.invitations.filter(
      (row) =>
        (where.id === undefined || row.id === where.id) &&
        (where.organizationId === undefined ||
          row.organizationId === where.organizationId) &&
        (where.status === undefined || row.status === where.status) &&
        (where.email === undefined ||
          row.email
            .toLowerCase()
            .includes(where.email.contains.toLowerCase())) &&
        matchesCursor(row, where.AND),
    );

  const findMember = (organizationId: string, userId: string) =>
    store.members.find(
      (row) => row.organizationId === organizationId && row.userId === userId,
    );

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
        findMany: async () => [],
        count: async () => 0,
      },
      invitation: {
        findUnique: async ({ where }: { where: InvitationKey }) => {
          if (where.organizationId_email) {
            const { organizationId, email } = where.organizationId_email;
            return (
              store.invitations.find(
                (row) =>
                  row.organizationId === organizationId && row.email === email,
              ) ?? null
            );
          }
          if (where.token !== undefined) {
            return (
              store.invitations.find((row) => row.token === where.token) ?? null
            );
          }
          return null;
        },
        // Mirror Prisma's `select` so a route can't accidentally leak a
        // column the service didn't ask for.
        findFirst: async ({
          where,
          select,
        }: {
          where: InvitationWhere;
          select?: Partial<Record<keyof InvitationRow, boolean>>;
        }) => {
          const row = filterInvitations(where)[0];
          if (!row) return null;
          if (!select) return row;
          const picked: Record<string, unknown> = {};
          for (const key of Object.keys(select) as (keyof InvitationRow)[]) {
            if (select[key]) picked[key] = row[key];
          }
          return picked;
        },
        findMany: async ({
          where,
          take,
        }: {
          where: InvitationWhere;
          take?: number;
        }) => {
          const rows = filterInvitations(where)
            .slice()
            .sort(
              (a, b) =>
                a.createdAt.getTime() - b.createdAt.getTime() ||
                a.id.localeCompare(b.id),
            );
          return take === undefined ? rows : rows.slice(0, take);
        },
        count: async ({ where }: { where: InvitationWhere }) =>
          filterInvitations(where).length,
        upsert: async ({
          where,
          create,
          update,
        }: {
          where: InvitationKey;
          create: Omit<InvitationRow, "id" | "createdAt">;
          update: Partial<InvitationRow>;
        }) => {
          const key = where.organizationId_email;
          if (!key) throw new Error("unexpected upsert key");
          const existing = store.invitations.find(
            (row) =>
              row.organizationId === key.organizationId &&
              row.email === key.email,
          );
          if (existing) {
            Object.assign(existing, update);
            return existing;
          }
          const row: InvitationRow = {
            id: `inv-${++store.seq}`,
            createdAt: new Date(),
            ...create,
          };
          store.invitations.push(row);
          return row;
        },
        updateMany: async ({
          where,
          data,
        }: {
          where: InvitationWhere;
          data: { status: string };
        }) => {
          const rows = filterInvitations(where);
          for (const row of rows) row.status = data.status;
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
const daysFromNow = (days: number) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000);

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

const invitation = (
  id: string,
  email: string,
  overrides: Partial<InvitationRow> = {},
): InvitationRow => ({
  id,
  organizationId: ORG,
  email,
  role: "member",
  token: `inv_token-${id}`,
  status: "pending",
  invitedById: ADMIN,
  invitedByEmail: "admin@example.com",
  expiresAt: daysFromNow(5),
  createdAt: at(10),
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
  ];
  store.members = [
    member(OWNER, "owner", at(0)),
    member(ADMIN, "admin", at(1)),
    member(MEMBER, "member", at(2)),
    member("user-outsider", "admin", at(3), OTHER_ORG),
  ];
  store.invitations = [
    invitation("inv-a", "alpha@example.com", { createdAt: at(10) }),
    invitation("inv-b", "beta@example.com", {
      createdAt: at(11),
      role: "admin",
    }),
    // An invitation in a DIFFERENT org — never visible through this org's routes.
    invitation("inv-x", "outsider@example.com", {
      organizationId: OTHER_ORG,
      createdAt: at(12),
    }),
  ];
  store.audits = [];
  store.seq = 100;
  store.sessionUserId = null;
});

const rowFor = (id: string) => store.invitations.find((row) => row.id === id);
const rowForEmail = (email: string) =>
  store.invitations.find(
    (row) => row.organizationId === ORG && row.email === email,
  );

const asAdmin = { headers: { Authorization: `Bearer ${ADMIN_KEY}` } };
const asProjectKey = { headers: { Authorization: `Bearer ${PROJECT_KEY}` } };

const create = (body: unknown, init: RequestInit = asAdmin) =>
  app.request("/v1/org/invitations", {
    ...init,
    method: "POST",
    body: JSON.stringify(body),
  });

const revoke = (id: string, init: RequestInit = asAdmin) =>
  app.request(`/v1/org/invitations/${id}`, { ...init, method: "DELETE" });

interface InvitationListBody {
  data: {
    id: string;
    email: string;
    role: string;
    status: string;
    invitedByEmail: string;
    expiresAt: string;
    createdAt: string;
    token: string;
  }[];
  nextCursor: string | null;
}

const list = async (query = ""): Promise<InvitationListBody> => {
  const res = await app.request(`/v1/org/invitations${query}`, asAdmin);
  expect(res.status).toBe(200);
  return (await res.json()) as InvitationListBody;
};

describe("GET /v1/org/invitations", () => {
  it("returns the org's invitations in the page envelope", async () => {
    const body = await list();
    expect(body.nextCursor).toBeNull();
    expect(body.data.map((row) => row.id)).toEqual(["inv-a", "inv-b"]);
    const first = rowFor("inv-a");
    expect(body.data[0]).toEqual({
      id: "inv-a",
      email: "alpha@example.com",
      role: "member",
      status: "pending",
      invitedByEmail: "admin@example.com",
      expiresAt: first?.expiresAt.toISOString(),
      createdAt: at(10).toISOString(),
      token: "inv_token-inv-a",
    });
  });

  it("never leaks invitations of another organization", async () => {
    const body = await list();
    expect(body.data.some((row) => row.id === "inv-x")).toBe(false);
  });

  it("filters by STORED status", async () => {
    const row = rowFor("inv-b");
    if (row) row.status = "cancelled";
    const body = await list("?status=cancelled");
    expect(body.data.map((r) => r.id)).toEqual(["inv-b"]);
  });

  it("filters by free-text q over email", async () => {
    const body = await list("?q=BETA");
    expect(body.data.map((r) => r.id)).toEqual(["inv-b"]);
  });

  it('projects a pending row past its expiry as "expired" without a write', async () => {
    const row = rowFor("inv-a");
    if (row) row.expiresAt = new Date(Date.now() - 1000);
    const body = await list();
    expect(body.data.find((r) => r.id === "inv-a")?.status).toBe("expired");
    // Display-only: the stored status is untouched.
    expect(rowFor("inv-a")?.status).toBe("pending");
  });

  it("pages with an opaque cursor and ends with nextCursor null", async () => {
    const first = await list("?limit=1");
    expect(first.data.map((r) => r.id)).toEqual(["inv-a"]);
    expect(first.nextCursor).toBeTruthy();

    const second = await list(
      `?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
    );
    expect(second.data.map((r) => r.id)).toEqual(["inv-b"]);
    expect(second.nextCursor).toBeNull();
  });

  it("treats a malformed cursor as the first page instead of failing", async () => {
    const body = await list("?cursor=not-a-real-cursor");
    expect(body.data).toHaveLength(2);
  });

  it("walks every page exactly once when createdAt ties", async () => {
    // Same millisecond for all: only the id half of the cursor can separate
    // them, so a one-at-a-time walk is the tiebreak's real test.
    store.invitations.push(invitation("inv-c", "gamma@example.com"));
    for (const row of store.invitations) row.createdAt = at(7);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const body: InvitationListBody = await list(
        `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      seen.push(...body.data.map((r) => r.id));
      cursor = body.nextCursor;
      if (!cursor) break;
    }

    expect(cursor).toBeNull();
    expect(seen.slice().sort()).toEqual(["inv-a", "inv-b", "inv-c"]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("rejects an out-of-range limit with 422", async () => {
    const res = await app.request("/v1/org/invitations?limit=5000", asAdmin);
    expect(res.status).toBe(422);
  });

  it("rejects limit=0 with 422", async () => {
    const res = await app.request("/v1/org/invitations?limit=0", asAdmin);
    expect(res.status).toBe(422);
  });

  it("rejects a non-numeric limit with 422", async () => {
    const res = await app.request("/v1/org/invitations?limit=abc", asAdmin);
    expect(res.status).toBe(422);
  });

  it("403s a project-scoped key even when its user is an org owner", async () => {
    const res = await app.request("/v1/org/invitations", asProjectKey);
    expect(res.status).toBe(403);
  });

  it("403s a non-admin member (deterministic, not a 401)", async () => {
    store.sessionUserId = MEMBER;
    const res = await app.request("/v1/org/invitations");
    expect(res.status).toBe(403);
  });

  it("rejects a suspended admin's org key (suspended reads as no role)", async () => {
    const row = store.members.find((m) => m.userId === ADMIN);
    if (row) row.status = "suspended";
    const res = await app.request("/v1/org/invitations", asAdmin);
    expect(res.status).toBe(401);
  });

  it("401s an unauthenticated caller", async () => {
    const res = await app.request("/v1/org/invitations");
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/org/invitations", () => {
  it("creates an invitation and returns the full row including the token", async () => {
    const res = await create({ email: "new@example.com", role: "member" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as InvitationListBody["data"][number];
    expect(body).toMatchObject({
      email: "new@example.com",
      role: "member",
      status: "pending",
      invitedByEmail: "admin@example.com",
    });
    expect(body.token).toMatch(/^inv_[0-9a-f]{64}$/);
    // ~7-day TTL.
    const ttlMs = new Date(body.expiresAt).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
    expect(rowForEmail("new@example.com")?.status).toBe("pending");
  });

  it("normalizes the address (trim + lowercase) before storing", async () => {
    const res = await create({
      email: "  New.User@Example.COM  ",
      role: "member",
    });
    expect(res.status).toBe(200);
    expect(rowForEmail("new.user@example.com")).toBeTruthy();
  });

  it("writes an audit row WITHOUT the token", async () => {
    const res = await create({ email: "new@example.com", role: "admin" });
    expect(res.status).toBe(200);
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({
      organizationId: ORG,
      userId: ADMIN,
      action: "create",
      service: "invitation",
      source: "api",
      metadata: { email: "new@example.com", role: "admin" },
    });
    expect(store.audits[0]?.metadata).toHaveProperty("invitationId");
    // The token is a bearer secret: never in the audit trail.
    expect(store.audits[0]?.metadata).not.toHaveProperty("token");
    expect(JSON.stringify(store.audits[0])).not.toContain("inv_");
  });

  it("422s a malformed email", async () => {
    const res = await create({ email: "not-an-email", role: "member" });
    expect(res.status).toBe(422);
  });

  it("422s a missing role", async () => {
    const res = await create({ email: "new@example.com" });
    expect(res.status).toBe(422);
  });

  it("422s the unassignable owner role", async () => {
    const res = await create({ email: "new@example.com", role: "owner" });
    expect(res.status).toBe(422);
  });

  it("422s a missing/unparseable body", async () => {
    const res = await app.request("/v1/org/invitations", {
      ...asAdmin,
      method: "POST",
    });
    expect(res.status).toBe(422);
  });

  it("400s a self-invite", async () => {
    const res = await create({ email: "admin@example.com", role: "member" });
    expect(res.status).toBe(400);
    expect(store.audits).toHaveLength(0);
  });

  it("409s an address that is already an active member", async () => {
    const res = await create({
      email: "member@elsewhere.test",
      role: "member",
    });
    expect(res.status).toBe(409);
  });

  it("409s a suspended member's address with the distinct reinstate message", async () => {
    const row = store.members.find((m) => m.userId === MEMBER);
    if (row) row.status = "suspended";
    const res = await create({
      email: "member@elsewhere.test",
      role: "member",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(JSON.stringify(body)).toContain("reinstate");
  });

  it("409s when a pending, unexpired invitation already exists", async () => {
    const res = await create({ email: "alpha@example.com", role: "member" });
    expect(res.status).toBe(409);
    // The existing row is untouched (same token).
    expect(rowForEmail("alpha@example.com")?.token).toBe("inv_token-inv-a");
  });

  it("409s at the pending-invitation cap", async () => {
    for (let i = 0; i < 100; i++) {
      store.invitations.push(
        invitation(`inv-cap-${i}`, `cap-${i}@example.com`),
      );
    }
    const res = await create({ email: "new@example.com", role: "member" });
    expect(res.status).toBe(409);
  });

  it("OVERWRITES a cancelled row: fresh token, pending again", async () => {
    const row = rowForEmail("alpha@example.com");
    if (row) row.status = "cancelled";
    const res = await create({ email: "alpha@example.com", role: "admin" });
    expect(res.status).toBe(200);
    const updated = rowForEmail("alpha@example.com");
    expect(updated?.status).toBe("pending");
    expect(updated?.role).toBe("admin");
    expect(updated?.token).not.toBe("inv_token-inv-a");
  });

  it("OVERWRITES an accepted row: fresh token, pending again", async () => {
    const row = rowForEmail("alpha@example.com");
    if (row) row.status = "accepted";
    const res = await create({ email: "alpha@example.com", role: "member" });
    expect(res.status).toBe(200);
    expect(rowForEmail("alpha@example.com")?.status).toBe("pending");
    expect(rowForEmail("alpha@example.com")?.token).not.toBe("inv_token-inv-a");
  });

  it("OVERWRITES an expired pending row: fresh token and expiry", async () => {
    const row = rowForEmail("alpha@example.com");
    if (row) row.expiresAt = new Date(Date.now() - 1000);
    const res = await create({ email: "alpha@example.com", role: "member" });
    expect(res.status).toBe(200);
    const updated = rowForEmail("alpha@example.com");
    expect(updated?.status).toBe("pending");
    expect(updated?.token).not.toBe("inv_token-inv-a");
    expect(updated && updated.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("403s a project-scoped key and audits nothing", async () => {
    const res = await create(
      { email: "new@example.com", role: "member" },
      asProjectKey,
    );
    expect(res.status).toBe(403);
    expect(store.audits).toHaveLength(0);
    expect(rowForEmail("new@example.com")).toBeUndefined();
  });

  it("403s a non-admin member and audits nothing", async () => {
    store.sessionUserId = MEMBER;
    const res = await create({ email: "new@example.com", role: "member" }, {});
    expect(res.status).toBe(403);
    expect(store.audits).toHaveLength(0);
  });
});

describe("DELETE /v1/org/invitations/:id", () => {
  it("revokes a pending invitation (status → cancelled) and audits it", async () => {
    const res = await revoke("inv-a");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "inv-a",
      email: "alpha@example.com",
    });
    expect(rowFor("inv-a")?.status).toBe("cancelled");
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({
      organizationId: ORG,
      userId: ADMIN,
      action: "delete",
      service: "invitation",
      source: "api",
      metadata: { invitationId: "inv-a", email: "alpha@example.com" },
    });
    expect(store.audits[0]?.metadata).not.toHaveProperty("token");
  });

  it("404s an unknown id and audits nothing", async () => {
    const res = await revoke("inv-nope");
    expect(res.status).toBe(404);
    expect(store.audits).toHaveLength(0);
  });

  it("404s an invitation of another organization (cross-org isolation)", async () => {
    const res = await revoke("inv-x");
    expect(res.status).toBe(404);
    expect(rowFor("inv-x")?.status).toBe("pending");
  });

  it("409s a non-pending invitation", async () => {
    const row = rowFor("inv-a");
    if (row) row.status = "cancelled";
    const res = await revoke("inv-a");
    expect(res.status).toBe(409);
  });

  it("403s a project-scoped key attempting a revoke", async () => {
    const res = await revoke("inv-a", asProjectKey);
    expect(res.status).toBe(403);
    expect(rowFor("inv-a")?.status).toBe("pending");
    expect(store.audits).toHaveLength(0);
  });
});
