import { beforeEach, describe, expect, it, vi } from "vitest";

// Accept-path invariants for the invitation service, exercised DIRECTLY (no
// HTTP): the accept surface is a Server Action, so these behaviors have no
// route test to live in. In-memory `@onecli/db` mock; the project provisioner
// (`ensureMemberDefaultProject`) is a spy — its own behavior is covered by
// organization-service.test.ts.

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "oss";
  process.env.SECRET_ENCRYPTION_KEY = "test-secret";
  process.env.OAUTH_STATE_SECRET = "test-secret";
});

interface OrgRow {
  id: string;
  name: string;
}
interface UserRow {
  id: string;
  externalAuthId: string;
  email: string;
  name: string | null;
}
interface MemberRow {
  organizationId: string;
  userId: string;
  userEmail: string;
  role: string;
  status: string;
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

const store = vi.hoisted(() => ({
  orgs: [] as OrgRow[],
  users: [] as UserRow[],
  members: [] as MemberRow[],
  invitations: [] as InvitationRow[],
  seq: 0,
}));

const ensureMemberDefaultProject = vi.hoisted(() =>
  vi.fn(async (organizationId: string) => ({
    id: `proj-of-${organizationId}`,
    organizationId,
  })),
);

vi.mock("./organization-service", () => ({
  ensureMemberDefaultProject,
}));

vi.mock("@onecli/db", () => {
  interface InvitationWhere {
    id?: string;
    status?: string;
    organizationId?: string;
  }

  const filterInvitations = (where: InvitationWhere) =>
    store.invitations.filter(
      (row) =>
        (where.id === undefined || row.id === where.id) &&
        (where.organizationId === undefined ||
          row.organizationId === where.organizationId) &&
        (where.status === undefined || row.status === where.status),
    );

  return {
    Prisma: { JsonNull: null },
    db: {
      invitation: {
        findUnique: async ({
          where,
          include,
        }: {
          where: { token?: string };
          include?: { organization?: unknown };
        }) => {
          const row = store.invitations.find((r) => r.token === where.token);
          if (!row) return null;
          if (!include?.organization) return { ...row };
          const org = store.orgs.find((o) => o.id === row.organizationId);
          return { ...row, organization: { name: org?.name ?? "?" } };
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
          where: { userId: string; organizationId?: { not: string } };
        }) =>
          store.members.find(
            (m) =>
              m.userId === where.userId &&
              (where.organizationId?.not === undefined ||
                m.organizationId !== where.organizationId.not),
          ) ?? null,
        upsert: async ({
          where,
          create,
        }: {
          where: {
            organizationId_userId: { organizationId: string; userId: string };
          };
          create: Omit<MemberRow, "status">;
        }) => {
          const { organizationId, userId } = where.organizationId_userId;
          const existing = store.members.find(
            (m) => m.organizationId === organizationId && m.userId === userId,
          );
          if (existing) return existing;
          const row: MemberRow = { status: "active", ...create };
          store.members.push(row);
          return row;
        },
      },
      user: {
        // Mirror Prisma's `select` so the service only sees what it asked for.
        findUnique: async ({
          where,
          select,
        }: {
          where: { externalAuthId?: string; email?: string };
          select?: Partial<Record<keyof UserRow, boolean>>;
        }) => {
          const row = store.users.find(
            (u) =>
              (where.externalAuthId !== undefined &&
                u.externalAuthId === where.externalAuthId) ||
              (where.email !== undefined && u.email === where.email),
          );
          if (!row) return null;
          if (!select) return row;
          const picked: Record<string, unknown> = {};
          for (const key of Object.keys(select) as (keyof UserRow)[]) {
            if (select[key]) picked[key] = row[key];
          }
          return picked;
        },
        create: async ({
          data,
        }: {
          data: { externalAuthId: string; email: string; name: string | null };
        }) => {
          const row: UserRow = {
            id: `user-${++store.seq}`,
            externalAuthId: data.externalAuthId,
            email: data.email,
            name: data.name,
          };
          store.users.push(row);
          return row;
        },
      },
    },
  };
});

import {
  acceptInvitation,
  describeInvitation,
  generateInvitationToken,
  resolveInviteeUser,
} from "./org-invitation-service";
import { IDENTITY_CONFLICT_ERROR } from "../routes/auth-session";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const TOKEN = "inv_test-token";

const daysFromNow = (days: number) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000);

const invitation = (overrides: Partial<InvitationRow> = {}): InvitationRow => ({
  id: "inv-1",
  organizationId: ORG,
  email: "dev@example.com",
  role: "admin",
  token: TOKEN,
  status: "pending",
  invitedById: "user-admin",
  invitedByEmail: "admin@example.com",
  expiresAt: daysFromNow(5),
  createdAt: new Date(),
  ...overrides,
});

beforeEach(() => {
  store.orgs = [
    { id: ORG, name: "Acme" },
    { id: OTHER_ORG, name: "Umbrella" },
  ];
  store.users = [
    {
      id: "user-dev",
      externalAuthId: "ext-dev",
      email: "dev@example.com",
      name: "Dev",
    },
  ];
  store.members = [];
  store.invitations = [invitation()];
  store.seq = 0;
  ensureMemberDefaultProject.mockClear();
});

const membershipsOf = (userId: string) =>
  store.members.filter((m) => m.userId === userId);

describe("acceptInvitation", () => {
  it("creates the membership with the INVITED role and returns the ensured project", async () => {
    const result = await acceptInvitation(TOKEN, "user-dev", "dev@example.com");

    expect(result).toEqual({
      organizationId: ORG,
      organizationName: "Acme",
      projectId: `proj-of-${ORG}`,
      role: "admin",
      alreadyMember: false,
      invitationId: "inv-1",
    });
    expect(membershipsOf("user-dev")).toEqual([
      {
        organizationId: ORG,
        userId: "user-dev",
        userEmail: "dev@example.com",
        role: "admin",
        status: "active",
      },
    ]);
    expect(store.invitations[0]?.status).toBe("accepted");
    // NOT best-effort: awaited, and its project id is what the caller returns.
    expect(ensureMemberDefaultProject).toHaveBeenCalledExactlyOnceWith(
      ORG,
      "user-dev",
      "dev@example.com",
    );
  });

  it("matches the invited email case-insensitively with surrounding whitespace", async () => {
    const result = await acceptInvitation(
      TOKEN,
      "user-dev",
      "  Dev@Example.COM ",
    );
    expect(result.alreadyMember).toBe(false);
    expect(membershipsOf("user-dev")).toHaveLength(1);
  });

  it("410s an expired invitation and lazily writes the status back", async () => {
    store.invitations[0]!.expiresAt = new Date(Date.now() - 1000);
    await expect(
      acceptInvitation(TOKEN, "user-dev", "dev@example.com"),
    ).rejects.toMatchObject({ code: "GONE" });
    expect(store.invitations[0]?.status).toBe("expired");
    expect(membershipsOf("user-dev")).toHaveLength(0);
    expect(ensureMemberDefaultProject).not.toHaveBeenCalled();
  });

  it("410s a cancelled invitation", async () => {
    store.invitations[0]!.status = "cancelled";
    await expect(
      acceptInvitation(TOKEN, "user-dev", "dev@example.com"),
    ).rejects.toMatchObject({ code: "GONE" });
    expect(store.invitations[0]?.status).toBe("cancelled");
    expect(membershipsOf("user-dev")).toHaveLength(0);
  });

  it("is single-use: the second accept 410s and exactly one membership exists", async () => {
    await acceptInvitation(TOKEN, "user-dev", "dev@example.com");
    // A second, different session replaying the link (membership was removed
    // out-of-band so the already-member arm can't answer).
    store.members = [];
    await expect(
      acceptInvitation(TOKEN, "user-dev", "dev@example.com"),
    ).rejects.toMatchObject({ code: "GONE" });
    expect(membershipsOf("user-dev")).toHaveLength(0);
  });

  it("403s an email mismatch WITHOUT burning the token", async () => {
    await expect(
      acceptInvitation(TOKEN, "user-dev", "someone-else@example.com"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The failed attempt must not consume the invitation or create state.
    expect(store.invitations[0]?.status).toBe("pending");
    expect(membershipsOf("user-dev")).toHaveLength(0);
    expect(ensureMemberDefaultProject).not.toHaveBeenCalled();
  });

  it("creates the membership in the TOKEN'S org only", async () => {
    store.invitations = [
      invitation({ organizationId: OTHER_ORG, token: "inv_other" }),
    ];
    const result = await acceptInvitation(
      "inv_other",
      "user-dev",
      "dev@example.com",
    );
    expect(result.organizationId).toBe(OTHER_ORG);
    expect(result.organizationName).toBe("Umbrella");
    expect(membershipsOf("user-dev").map((m) => m.organizationId)).toEqual([
      OTHER_ORG,
    ]);
  });

  it("is idempotent for an already-active member (keeps their EXISTING role)", async () => {
    store.members.push({
      organizationId: ORG,
      userId: "user-dev",
      userEmail: "dev@example.com",
      role: "member",
      status: "active",
    });

    const result = await acceptInvitation(TOKEN, "user-dev", "dev@example.com");

    expect(result.alreadyMember).toBe(true);
    // The invitation (role: admin) must NOT escalate an existing membership.
    expect(result.role).toBe("member");
    expect(membershipsOf("user-dev")).toHaveLength(1);
    expect(membershipsOf("user-dev")[0]?.role).toBe("member");
    expect(store.invitations[0]?.status).toBe("accepted");
    // The find-or-create still runs: the member needs a project to land on.
    expect(ensureMemberDefaultProject).toHaveBeenCalledOnce();
  });

  it("409s a suspended member and leaves everything untouched", async () => {
    store.members.push({
      organizationId: ORG,
      userId: "user-dev",
      userEmail: "dev@example.com",
      role: "member",
      status: "suspended",
    });

    await expect(
      acceptInvitation(TOKEN, "user-dev", "dev@example.com"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store.invitations[0]?.status).toBe("pending");
    expect(membershipsOf("user-dev")[0]?.status).toBe("suspended");
    expect(ensureMemberDefaultProject).not.toHaveBeenCalled();
  });

  it("404s an unknown token with a generic message", async () => {
    await expect(
      acceptInvitation("inv_who-knows", "user-dev", "dev@example.com"),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Invitation not found.",
    });
  });
});

describe("resolveInviteeUser", () => {
  it("creates the user row for a brand-new identity", async () => {
    const user = await resolveInviteeUser("ext-new", "new@example.com", "New");
    expect(user.email).toBe("new@example.com");
    expect(
      store.users.find((u) => u.externalAuthId === "ext-new"),
    ).toBeTruthy();
  });

  it("reuses an existing row by externalAuthId", async () => {
    const user = await resolveInviteeUser("ext-dev", "dev@example.com");
    expect(user).toEqual({ id: "user-dev", email: "dev@example.com" });
    expect(store.users).toHaveLength(1);
  });

  it("REFUSES an email owned by a different auth identity (never relinks)", async () => {
    await expect(
      resolveInviteeUser("ext-imposter", "dev@example.com"),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: IDENTITY_CONFLICT_ERROR,
    });
    // No row was created for the conflicting identity.
    expect(
      store.users.find((u) => u.externalAuthId === "ext-imposter"),
    ).toBeUndefined();
  });
});

describe("describeInvitation", () => {
  const viewer = { externalAuthId: "ext-dev", email: "dev@example.com" };

  it("answers not-found for an unknown token, with NOTHING but the state", async () => {
    const view = await describeInvitation("inv_who-knows", null);
    expect(view).toEqual({ state: "not-found" });
  });

  it("answers signin-required with the invite summary for a signed-out visitor", async () => {
    const view = await describeInvitation(TOKEN, null);
    expect(view).toMatchObject({
      state: "signin-required",
      organizationName: "Acme",
      invitedEmail: "dev@example.com",
      role: "admin",
      invitedByEmail: "admin@example.com",
    });
  });

  it("answers ready for the invited visitor", async () => {
    const view = await describeInvitation(TOKEN, viewer);
    expect(view).toMatchObject({ state: "ready", organizationName: "Acme" });
  });

  it("answers ready for a signed-in visitor with NO user row yet", async () => {
    const view = await describeInvitation(TOKEN, {
      externalAuthId: "ext-brand-new",
      email: "dev@example.com",
    });
    expect(view).toMatchObject({ state: "ready" });
  });

  it("answers wrong-email naming both addresses", async () => {
    const view = await describeInvitation(TOKEN, {
      externalAuthId: "ext-other",
      email: "other@example.com",
    });
    expect(view).toEqual({
      state: "wrong-email",
      organizationName: "Acme",
      invitedEmail: "dev@example.com",
      viewerEmail: "other@example.com",
    });
  });

  it("answers revoked / accepted for those stored statuses", async () => {
    store.invitations[0]!.status = "cancelled";
    expect(await describeInvitation(TOKEN, null)).toEqual({
      state: "revoked",
      organizationName: "Acme",
    });
    store.invitations[0]!.status = "accepted";
    expect(await describeInvitation(TOKEN, viewer)).toEqual({
      state: "accepted",
      organizationName: "Acme",
    });
  });

  it("projects a past-expiry pending row as expired WITHOUT writing", async () => {
    store.invitations[0]!.expiresAt = new Date(Date.now() - 1000);
    expect(await describeInvitation(TOKEN, viewer)).toEqual({
      state: "expired",
      organizationName: "Acme",
    });
    // Read-only: the lazy write-back belongs to the accept path alone.
    expect(store.invitations[0]?.status).toBe("pending");
  });

  it("answers already-member / suspended from the viewer's membership, outranking status", async () => {
    store.members.push({
      organizationId: ORG,
      userId: "user-dev",
      userEmail: "dev@example.com",
      role: "member",
      status: "active",
    });
    store.invitations[0]!.status = "accepted";
    expect(await describeInvitation(TOKEN, viewer)).toEqual({
      state: "already-member",
      organizationName: "Acme",
    });

    store.members[0]!.status = "suspended";
    expect(await describeInvitation(TOKEN, viewer)).toEqual({
      state: "suspended",
      organizationName: "Acme",
    });
  });

  it("answers other-org for a user who already has their own workspace (D-A)", async () => {
    store.members.push({
      organizationId: OTHER_ORG,
      userId: "user-dev",
      userEmail: "dev@example.com",
      role: "owner",
      status: "active",
    });
    const view = await describeInvitation(TOKEN, viewer);
    expect(view).toMatchObject({
      state: "other-org",
      organizationName: "Acme",
      invitedEmail: "dev@example.com",
    });
  });
});

describe("generateInvitationToken", () => {
  it("emits inv_ + 64 hex chars, unique across 1000 draws", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const token = generateInvitationToken();
      expect(token).toMatch(/^inv_[0-9a-f]{64}$/);
      tokens.add(token);
    }
    expect(tokens.size).toBe(1000);
  });
});
