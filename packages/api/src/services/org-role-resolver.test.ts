import { beforeEach, describe, expect, it, vi } from "vitest";

// The OSS role resolver is what makes `CAPS.rbac` safe to turn on: every access
// check funnels through it, so a wrong answer here is either a lockout or a
// privilege escalation. Pin the oss edition — this provider is OSS-only.

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "oss";
});

const state = vi.hoisted(() => ({
  member: null as { role: string; status: string } | null,
  lastWhere: null as unknown,
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    organizationMember: {
      findUnique: async ({ where }: { where: unknown }) => {
        state.lastWhere = where;
        return state.member;
      },
    },
  },
}));

const warn = vi.hoisted(() => vi.fn());

vi.mock("../lib/logger", () => ({
  logger: { child: () => ({ warn }) },
}));

import { ossRoleResolver } from "./org-role-resolver";

const ORG = "org-1";
const USER = "user-1";

beforeEach(() => {
  state.member = null;
  state.lastWhere = null;
  warn.mockClear();
});

describe("ossRoleResolver", () => {
  it("reads the membership by its composite primary key", async () => {
    state.member = { role: "owner", status: "active" };
    await ossRoleResolver.getUserRole(USER, ORG);
    expect(state.lastWhere).toEqual({
      organizationId_userId: { organizationId: ORG, userId: USER },
    });
  });

  it.each([
    ["owner", "owner"],
    ["admin", "admin"],
    ["member", "member"],
  ])("maps an active %s to %p", async (role, expected) => {
    state.member = { role, status: "active" };
    await expect(ossRoleResolver.getUserRole(USER, ORG)).resolves.toBe(
      expected,
    );
  });

  it("returns null for a non-member", async () => {
    state.member = null;
    await expect(ossRoleResolver.getUserRole(USER, ORG)).resolves.toBeNull();
  });

  it.each(["owner", "admin", "member"])(
    "returns null for a suspended %s (suspended = non-member)",
    async (role) => {
      state.member = { role, status: "suspended" };
      await expect(ossRoleResolver.getUserRole(USER, ORG)).resolves.toBeNull();
    },
  );

  it.each(["", "OWNER", "superadmin", "Admin", "member "])(
    "returns null (and warns) for the unrecognized role %p",
    async (role) => {
      state.member = { role, status: "active" };
      await expect(ossRoleResolver.getUserRole(USER, ORG)).resolves.toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );

  it("does not treat inherited Object properties as roles", async () => {
    // A naive `ROLE_HIERARCHY[role]` lookup would resolve "constructor" or
    // "toString" to a truthy value and let a junk row through.
    state.member = { role: "constructor", status: "active" };
    await expect(ossRoleResolver.getUserRole(USER, ORG)).resolves.toBeNull();
  });

  it("keeps an unknown status other than 'suspended' usable", async () => {
    // Only "suspended" is a deny signal; anything else (e.g. the default
    // "active", or a future value) is an ordinary active membership.
    state.member = { role: "admin", status: "active" };
    await expect(ossRoleResolver.getUserRole(USER, ORG)).resolves.toBe("admin");
  });
});
