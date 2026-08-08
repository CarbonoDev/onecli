import { beforeEach, describe, expect, it, vi } from "vitest";

// `canManageProject` in isolation, for the one case the route suite cannot
// reach: an edition with NO RoleResolver registered. `initRoleResolver` is a
// module singleton set by `createApiApp`, so it can only be observed unset in
// a file that mocks the providers module outright.
//
// The invariant: MANAGEMENT must fail closed. Unlike `canAccessProjectAsUser`
// (a USAGE check, which no-ops to `true` for editions without roles), a
// management check that allowed everyone when roles are unavailable would let
// any member rename or delete any project.

const store = vi.hoisted(() => ({
  /** An `owner` binding that exists — and must still not be consulted. */
  ownerBinding: true,
  resolverRole: null as string | null,
}));

vi.mock("@onecli/db", () => ({
  db: {
    projectAccess: {
      findFirst: async () => (store.ownerBinding ? { id: "pa-1" } : null),
    },
  },
}));

vi.mock("../providers", () => ({
  ROLE_HIERARCHY: { member: 1, admin: 2, owner: 3 },
  // No resolver registered — the edition never called `initRoleResolver`.
  getRoleResolver: () =>
    store.resolverRole === null
      ? null
      : { getUserRole: async () => store.resolverRole },
  getNewOrgPolicySeeder: () => ({ seed: async () => {} }),
}));

import { canManageProject } from "./project-service";

beforeEach(() => {
  store.ownerBinding = true;
  store.resolverRole = null;
});

describe("canManageProject without a RoleResolver", () => {
  it("denies, even when an owner binding exists", async () => {
    await expect(canManageProject("u-1", "org-1", "proj-1")).resolves.toBe(
      false,
    );
  });
});

describe("canManageProject with a resolver", () => {
  it("denies a user the resolver reports no role for (suspended / non-member)", async () => {
    store.resolverRole = null;
    await expect(canManageProject("u-1", "org-1", "proj-1")).resolves.toBe(
      false,
    );
  });

  it("allows an org admin with no binding at all", async () => {
    store.resolverRole = "admin";
    store.ownerBinding = false;
    await expect(canManageProject("u-1", "org-1", "proj-1")).resolves.toBe(
      true,
    );
  });

  it("allows a plain member holding an owner binding, and denies them without one", async () => {
    store.resolverRole = "member";
    await expect(canManageProject("u-1", "org-1", "proj-1")).resolves.toBe(
      true,
    );
    store.ownerBinding = false;
    await expect(canManageProject("u-1", "org-1", "proj-1")).resolves.toBe(
      false,
    );
  });
});
