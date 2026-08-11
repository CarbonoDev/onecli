import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoleResolver } from "../providers";

// Minimal in-memory `@onecli/db` mock — just the operations
// `joinSharedOrganization` touches — so we can assert the single-org invariants
// (one shared org, per-user projects, idempotency) without a real database.

interface OrgRow {
  id: string;
  slug: string;
  name: string;
}
interface MemberRow {
  organizationId: string;
  userId: string;
  userEmail: string;
  role: string;
  /** Absent on the provisioning writes; Prisma defaults it to "active". */
  status?: string;
}
interface ProjectRow {
  id: string;
  name: string | null;
  slug: string | null;
  organizationId: string;
  createdByUserId: string | null;
  createdByUserEmail: string | null;
  seq: number;
}
interface BindingRow {
  projectId: string;
  /** Exactly one of userId/groupId, as the DB CHECK requires. */
  userId?: string;
  groupId?: string;
  role: string;
}
interface GroupMemberRow {
  groupId: string;
  userId: string;
}
interface ApiKeyRow {
  key: string;
  userId: string;
  userEmail: string;
  organizationId: string;
  scope: string;
}

const store = vi.hoisted(() => ({
  orgs: [] as OrgRow[],
  members: [] as MemberRow[],
  projects: [] as ProjectRow[],
  bindings: [] as BindingRow[],
  groupMembers: [] as GroupMemberRow[],
  apiKeys: [] as ApiKeyRow[],
  seq: 0,
  /** What `getRoleResolver()` answers — null models an edition with none. */
  roleResolver: null as RoleResolver | null,
}));

vi.mock("@onecli/db", () => {
  /** The subset of the Prisma project `where` shapes these helpers build. */
  interface BindingClause {
    userId?: string;
    group?: { members: { some: { userId: string } } };
  }
  interface ProjectWhere {
    // Plain id (attachMemberToProject resolving the inviter's choice) as well
    // as the exclusion form the lockout oracle uses.
    id?: string | { not: string };
    organizationId?: string;
    createdByUserId?: string;
    organization?: {
      members: { some: { userId: string; status?: { not?: string } } };
    };
    accessBindings?: { some: { OR: BindingClause[] } };
    OR?: ProjectWhere[];
  }

  /** A binding on `projectId` satisfying any clause — direct or via a group. */
  const matchesBinding = (projectId: string, clauses: BindingClause[]) =>
    clauses.some((clause) => {
      if (clause.userId !== undefined) {
        return store.bindings.some(
          (b) => b.projectId === projectId && b.userId === clause.userId,
        );
      }
      const userId = clause.group?.members.some.userId;
      if (userId === undefined) return false;
      return store.bindings.some(
        (b) =>
          b.projectId === projectId &&
          b.groupId !== undefined &&
          store.groupMembers.some(
            (gm) => gm.groupId === b.groupId && gm.userId === userId,
          ),
      );
    });

  const matchesProject = (p: ProjectRow, where: ProjectWhere): boolean => {
    if (typeof where.id === "string" && p.id !== where.id) return false;
    if (
      where.id !== undefined &&
      typeof where.id !== "string" &&
      where.id.not !== undefined &&
      p.id === where.id.not
    )
      return false;
    if (
      where.organizationId !== undefined &&
      p.organizationId !== where.organizationId
    )
      return false;
    if (
      where.createdByUserId !== undefined &&
      p.createdByUserId !== where.createdByUserId
    )
      return false;
    if (where.organization) {
      const { userId, status } = where.organization.members.some;
      const membership = store.members.find(
        (m) => m.organizationId === p.organizationId && m.userId === userId,
      );
      if (!membership) return false;
      if (
        status?.not !== undefined &&
        (membership.status ?? "active") === status.not
      )
        return false;
    }
    if (
      where.accessBindings &&
      !matchesBinding(p.id, where.accessBindings.some.OR)
    )
      return false;
    if (where.OR && !where.OR.some((sub) => matchesProject(p, sub)))
      return false;
    return true;
  };

  return {
    db: {
      organization: {
        // Two lookup shapes: by `slug` (the onprem bootstrap) and by `id`
        // (`renameOrganization`'s read-back), the latter honouring `select`.
        findUnique: async ({
          where,
          select,
        }: {
          where: { slug?: string; id?: string };
          select?: Partial<Record<keyof OrgRow, boolean>>;
        }) => {
          const org =
            store.orgs.find(
              (o) =>
                (where.slug !== undefined && o.slug === where.slug) ||
                (where.id !== undefined && o.id === where.id),
            ) ?? null;
          if (!org || !select) return org;
          const picked: Record<string, unknown> = {};
          for (const key of Object.keys(select) as (keyof OrgRow)[]) {
            if (select[key]) picked[key] = org[key];
          }
          return picked;
        },
        // Partial update, like Prisma: only the keys `data` carries are
        // written, so a rename that leaked `slug` would surface here.
        updateMany: async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<OrgRow>;
        }) => {
          const rows = store.orgs.filter((o) => o.id === where.id);
          for (const row of rows) Object.assign(row, data);
          return { count: rows.length };
        },
        findUniqueOrThrow: async ({
          where: { slug },
        }: {
          where: { slug: string };
        }) => {
          const org = store.orgs.find((o) => o.slug === slug);
          if (!org) throw new Error(`org ${slug} not found`);
          return org;
        },
        create: async ({ data }: { data: OrgRow }) => {
          if (store.orgs.some((o) => o.slug === data.slug)) {
            throw new Error("unique constraint: organization.slug");
          }
          const org: OrgRow = { id: data.id, slug: data.slug, name: data.name };
          store.orgs.push(org);
          return org;
        },
      },
      organizationMember: {
        // The row `ossRoleResolver` reads — the role source of truth in OSS.
        findUnique: async ({
          where: { organizationId_userId },
        }: {
          where: {
            organizationId_userId: { organizationId: string; userId: string };
          };
        }) =>
          store.members.find(
            (m) =>
              m.organizationId === organizationId_userId.organizationId &&
              m.userId === organizationId_userId.userId,
          ) ?? null,
        // listUserOrganizations: active memberships joined to their org.
        findMany: async ({
          where,
        }: {
          where: { userId: string; status?: { not?: string } };
        }) =>
          store.members
            .filter((m) => {
              if (m.userId !== where.userId) return false;
              if (
                where.status?.not !== undefined &&
                (m.status ?? "active") === where.status.not
              )
                return false;
              return true;
            })
            .map((m) => {
              const org = store.orgs.find((o) => o.id === m.organizationId);
              return {
                role: m.role,
                organization: {
                  id: m.organizationId,
                  name: org?.name ?? "",
                  slug: org?.slug ?? "",
                },
              };
            }),
        upsert: async ({
          where: { organizationId_userId },
          create,
        }: {
          where: {
            organizationId_userId: { organizationId: string; userId: string };
          };
          create: MemberRow;
        }) => {
          const existing = store.members.find(
            (m) =>
              m.organizationId === organizationId_userId.organizationId &&
              m.userId === organizationId_userId.userId,
          );
          if (existing) return existing;
          store.members.push(create);
          return create;
        },
        findFirst: async ({
          where,
        }: {
          where: { userId: string; status?: { not?: string } };
        }) =>
          store.members.find(
            (m) =>
              m.userId === where.userId &&
              !(
                where.status?.not !== undefined &&
                (m.status ?? "active") === where.status.not
              ),
          ) ?? null,
      },
      projectAccess: {
        // attachMemberToProject binds via createMany + skipDuplicates so two
        // concurrent accepts cannot collide on @@unique([projectId, userId]).
        createMany: async ({
          data,
          skipDuplicates,
        }: {
          data: { projectId: string; userId: string; role: string }[];
          skipDuplicates?: boolean;
        }) => {
          let count = 0;
          for (const row of data) {
            const dupe = store.bindings.some(
              (b) => b.projectId === row.projectId && b.userId === row.userId,
            );
            if (dupe && skipDuplicates) continue;
            store.bindings.push({
              projectId: row.projectId,
              userId: row.userId,
              role: row.role,
            });
            count += 1;
          }
          return { count };
        },
      },
      project: {
        findFirst: async ({
          where,
          select,
        }: {
          where: ProjectWhere;
          select?: { id?: boolean; organizationId?: boolean };
        }) => {
          const row =
            store.projects
              .filter((p) => matchesProject(p, where))
              .sort((a, b) => a.seq - b.seq)[0] ?? null;
          // Honour Prisma's `select` so callers see the same narrow shape they
          // asked for (these helpers only ever select id + organizationId).
          if (!row || !select) return row;
          const picked: Record<string, unknown> = {};
          if (select.id) picked.id = row.id;
          if (select.organizationId) picked.organizationId = row.organizationId;
          return picked;
        },
        create: async ({
          data,
        }: {
          data: Omit<ProjectRow, "seq"> & {
            accessBindings?: { create: { userId: string; role: string } };
          };
        }) => {
          if (
            store.projects.some(
              (p) =>
                p.organizationId === data.organizationId &&
                p.slug === data.slug,
            )
          ) {
            throw new Error("unique constraint: (organizationId, slug)");
          }
          const project: ProjectRow = { ...data, seq: store.seq++ };
          store.projects.push(project);
          // Materialize the nested binding write so the binding-fallback arm of
          // findUserDefaultProject has something real to find.
          if (data.accessBindings) {
            store.bindings.push({
              projectId: data.id,
              ...data.accessBindings.create,
            });
          }
          return project;
        },
      },
      apiKey: {
        findFirst: async ({
          where: { organizationId, scope },
        }: {
          where: { organizationId: string; scope: string };
        }) =>
          store.apiKeys.find(
            (k) => k.organizationId === organizationId && k.scope === scope,
          ) ?? null,
        create: async ({ data }: { data: ApiKeyRow }) => {
          if (store.apiKeys.some((k) => k.key === data.key)) {
            throw new Error("unique constraint: api_key.key");
          }
          store.apiKeys.push(data);
          return data;
        },
      },
    },
  };
});

vi.mock("../lib/logger", () => {
  const log = {
    warn: () => {},
    info: () => {},
    error: () => {},
    child: () => log,
  };
  return { logger: log };
});

// `requireOrgAdmin` reads the resolver through this seam, and its fail-closed
// arm is "no resolver registered" — a state `initRoleResolver` cannot restore
// once set, so the getter is the thing the tests steer.
vi.mock("../providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers")>();
  return { ...actual, getRoleResolver: () => store.roleResolver };
});

import {
  attachMemberToProject,
  joinSharedOrganization,
  hasResolvableProjectExcluding,
  findUserDefaultProject,
  listUserOrganizations,
  renameOrganization,
  requireOrgAdmin,
  validateOrgName,
  SHARED_ORG_SLUG,
} from "./organization-service";
import { ServiceError } from "./errors";
import { ossRoleResolver } from "./org-role-resolver";

beforeEach(() => {
  store.orgs = [];
  store.members = [];
  store.projects = [];
  store.bindings = [];
  store.groupMembers = [];
  store.apiKeys = [];
  store.seq = 0;
  store.roleResolver = ossRoleResolver;
  delete process.env.ONECLI_ORG_API_KEY;
  delete process.env.ONECLI_ORG_API_KEY_FILE;
});

const ORG = "org-host";
const HOST = "user-host";
const GUEST = "user-guest";

const seedOrgWithMember = (userId: string, role = "member") => {
  store.orgs.push({ id: ORG, slug: "host", name: "Host" });
  store.members.push({
    organizationId: ORG,
    userId,
    userEmail: `${userId}@example.com`,
    role,
  });
};

describe("joinSharedOrganization", () => {
  it("creates the one shared org and a project for the first user", async () => {
    const { organization, project } = await joinSharedOrganization(
      "user-aaaaaaaa",
      "a@example.com",
    );

    expect(store.orgs).toHaveLength(1);
    expect(store.orgs[0]?.slug).toBe(SHARED_ORG_SLUG);
    expect(organization.id).toBe(store.orgs[0]?.id);
    expect(project.organizationId).toBe(organization.id);
    expect(store.members).toHaveLength(1);
    expect(store.projects).toHaveLength(1);
    // The creator's ProjectAccess binding is seeded owner (step 13c) with the project.
    expect(
      (store.projects[0] as { accessBindings?: unknown }).accessBindings,
    ).toEqual({ create: { userId: "user-aaaaaaaa", role: "owner" } });
  });

  it("puts a second user in the SAME org with a distinct project", async () => {
    const first = await joinSharedOrganization(
      "user-aaaaaaaa",
      "a@example.com",
    );
    const second = await joinSharedOrganization(
      "user-bbbbbbbb",
      "b@example.com",
    );

    expect(store.orgs).toHaveLength(1); // one shared org
    expect(second.organization.id).toBe(first.organization.id);
    expect(second.project.id).not.toBe(first.project.id); // distinct projects
    expect(store.members).toHaveLength(2);
    expect(store.projects).toHaveLength(2);
  });

  it("is idempotent when the same user joins again", async () => {
    const first = await joinSharedOrganization(
      "user-aaaaaaaa",
      "a@example.com",
    );
    const again = await joinSharedOrganization(
      "user-aaaaaaaa",
      "a@example.com",
    );

    expect(again.organization.id).toBe(first.organization.id);
    expect(again.project.id).toBe(first.project.id);
    expect(store.orgs).toHaveLength(1);
    expect(store.members).toHaveLength(1);
    expect(store.projects).toHaveLength(1);
  });

  it("avoids project-slug collisions for ids sharing a prefix", async () => {
    // Distinct user ids whose first 8 chars match — the per-user project slug
    // must still be unique within the shared org (it uses the full user id).
    const first = await joinSharedOrganization(
      "dup12345-aaaa",
      "a@example.com",
    );
    const second = await joinSharedOrganization(
      "dup12345-bbbb",
      "b@example.com",
    );

    expect(second.organization.id).toBe(first.organization.id);
    expect(second.project.id).not.toBe(first.project.id);
    expect(store.projects).toHaveLength(2);
  });
});

describe("bootstrap org API key (via joinSharedOrganization)", () => {
  it("generates one org-scoped key for the shared org, owned by the first user", async () => {
    await joinSharedOrganization("user-aaaaaaaa", "a@example.com");

    expect(store.apiKeys).toHaveLength(1);
    const key = store.apiKeys[0]!;
    expect(key.scope).toBe("organization");
    expect(key.organizationId).toBe(store.orgs[0]?.id);
    expect(key.userId).toBe("user-aaaaaaaa");
    expect(key.key).toMatch(/^oc_org_[0-9a-f]{64}$/);
  });

  it("is idempotent — a second user's join adds no new org key", async () => {
    await joinSharedOrganization("user-aaaaaaaa", "a@example.com");
    await joinSharedOrganization("user-bbbbbbbb", "b@example.com");

    expect(store.apiKeys).toHaveLength(1);
  });

  it("uses ONECLI_ORG_API_KEY when set and valid", async () => {
    const supplied = "oc_org_" + "a".repeat(64);
    process.env.ONECLI_ORG_API_KEY = supplied;

    await joinSharedOrganization("user-aaaaaaaa", "a@example.com");

    expect(store.apiKeys).toHaveLength(1);
    expect(store.apiKeys[0]?.key).toBe(supplied);
  });

  it("fails loudly on a malformed ONECLI_ORG_API_KEY", async () => {
    process.env.ONECLI_ORG_API_KEY = "not-a-valid-key";

    await expect(
      joinSharedOrganization("user-aaaaaaaa", "a@example.com"),
    ).rejects.toThrow(/ONECLI_ORG_API_KEY/);
  });
});

// `hasResolvableProjectExcluding` is `deleteProject`'s lockout oracle, and it
// must answer exactly what `findUserDefaultProject` would find once the named
// project is gone. Every arm below has a twin above; drift between the two is a
// lockout (the user resolves no project and gets a 401 on every request).

describe("hasResolvableProjectExcluding", () => {
  const seedProject = (
    id: string,
    createdByUserId: string | null,
    organizationId = ORG,
  ) => {
    store.projects.push({
      id,
      name: "Default",
      slug: id,
      organizationId,
      createdByUserId,
      createdByUserEmail: null,
      seq: store.seq++,
    });
  };

  it("is false when the excluded project is the user's only one", async () => {
    seedOrgWithMember(GUEST);
    seedProject("proj-only", GUEST);
    store.bindings.push({
      projectId: "proj-only",
      userId: GUEST,
      role: "owner",
    });

    await expect(
      hasResolvableProjectExcluding(GUEST, "proj-only"),
    ).resolves.toBe(false);
  });

  it("is true through a project they CREATED (arm 1)", async () => {
    seedOrgWithMember(GUEST);
    seedProject("proj-a", GUEST);
    seedProject("proj-b", GUEST);

    await expect(hasResolvableProjectExcluding(GUEST, "proj-a")).resolves.toBe(
      true,
    );
  });

  it("is true through a DIRECT binding on another project (arm 2)", async () => {
    seedOrgWithMember(HOST, "owner");
    store.members.push({
      organizationId: ORG,
      userId: GUEST,
      userEmail: "guest@example.com",
      role: "member",
    });
    seedProject("proj-a", HOST);
    seedProject("proj-b", HOST);
    store.bindings.push({ projectId: "proj-a", userId: GUEST, role: "member" });
    store.bindings.push({ projectId: "proj-b", userId: GUEST, role: "member" });

    await expect(hasResolvableProjectExcluding(GUEST, "proj-a")).resolves.toBe(
      true,
    );
  });

  it("is true through a GROUP binding on another project (arm 2)", async () => {
    seedOrgWithMember(HOST, "owner");
    store.members.push({
      organizationId: ORG,
      userId: GUEST,
      userEmail: "guest@example.com",
      role: "member",
    });
    seedProject("proj-a", HOST);
    seedProject("proj-b", HOST);
    store.bindings.push({ projectId: "proj-a", userId: GUEST, role: "member" });
    store.bindings.push({
      projectId: "proj-b",
      groupId: "g-1",
      role: "member",
    });
    store.groupMembers.push({ groupId: "g-1", userId: GUEST });

    await expect(hasResolvableProjectExcluding(GUEST, "proj-a")).resolves.toBe(
      true,
    );
    // ...and the group path is the ONLY one left, so removing it flips it.
    store.groupMembers = [];
    await expect(hasResolvableProjectExcluding(GUEST, "proj-a")).resolves.toBe(
      false,
    );
  });

  it("ignores a project in an org the user is only SUSPENDED in", async () => {
    seedOrgWithMember(GUEST);
    const suspended = store.members.find((m) => m.userId === GUEST);
    if (suspended) suspended.status = "suspended";
    seedProject("proj-a", GUEST);
    seedProject("proj-b", GUEST);

    await expect(hasResolvableProjectExcluding(GUEST, "proj-a")).resolves.toBe(
      false,
    );
  });

  it("ignores projects of an org the user does not belong to", async () => {
    seedOrgWithMember(GUEST);
    seedProject("proj-a", GUEST);
    store.orgs.push({ id: "org-other", slug: "other", name: "Other" });
    seedProject("proj-foreign", GUEST, "org-other");

    await expect(hasResolvableProjectExcluding(GUEST, "proj-a")).resolves.toBe(
      false,
    );
  });
});

// ── org switching ───────────────────────────────────────────────────────────

const OTHER_ORG = "org-other";

const seedOtherOrgWithMember = (userId: string, role = "member") => {
  store.orgs.push({ id: OTHER_ORG, slug: "other", name: "Other" });
  store.members.push({
    organizationId: OTHER_ORG,
    userId,
    userEmail: `${userId}@example.com`,
    role,
  });
};

const seedProjectIn = (
  id: string,
  organizationId: string,
  createdByUserId: string | null,
) => {
  store.projects.push({
    id,
    name: "Default",
    slug: id,
    organizationId,
    createdByUserId,
    createdByUserEmail: null,
    seq: store.seq++,
  });
};

describe("findUserDefaultProject with a preferred organization", () => {
  it("resolves the preferred org's project over an older one elsewhere", async () => {
    // Without the preference the OLDER project (in ORG) wins on createdAt, so
    // this proves the fence is doing the work rather than the ordering.
    seedOrgWithMember(GUEST);
    seedOtherOrgWithMember(GUEST);
    seedProjectIn("proj-host", ORG, GUEST);
    seedProjectIn("proj-other", OTHER_ORG, GUEST);

    await expect(findUserDefaultProject(GUEST)).resolves.toMatchObject({
      id: "proj-host",
    });
    await expect(
      findUserDefaultProject(GUEST, OTHER_ORG),
    ).resolves.toMatchObject({ id: "proj-other" });
  });

  it("falls back rather than stranding the caller when the preference resolves nothing", async () => {
    // THE LOCKOUT GUARD. A stale selection — org left, membership suspended,
    // its last project deleted — must not resolve to no project at all, or
    // session auth 401s the user everywhere.
    seedOrgWithMember(GUEST);
    seedProjectIn("proj-host", ORG, GUEST);

    await expect(
      findUserDefaultProject(GUEST, "org-that-does-not-exist"),
    ).resolves.toMatchObject({ id: "proj-host" });
  });

  it("does not let a preference reach an org the caller does not belong to", async () => {
    // The fence only narrows: the active-membership gate still applies, so a
    // forged X-Organization-Id cannot promote a stranger's project.
    seedOrgWithMember(GUEST);
    seedProjectIn("proj-host", ORG, GUEST);
    store.orgs.push({ id: OTHER_ORG, slug: "other", name: "Other" });
    seedProjectIn("proj-foreign", OTHER_ORG, HOST);

    await expect(
      findUserDefaultProject(GUEST, OTHER_ORG),
    ).resolves.toMatchObject({ id: "proj-host" });
  });

  it("still agrees with hasResolvableProjectExcluding", async () => {
    // The two predicates must describe the same set. The preference narrows
    // which project WINS, never which projects can resolve at all — so the
    // lockout oracle stays correct without learning about orgs.
    seedOrgWithMember(GUEST);
    seedOtherOrgWithMember(GUEST);
    seedProjectIn("proj-host", ORG, GUEST);
    seedProjectIn("proj-other", OTHER_ORG, GUEST);

    await expect(
      hasResolvableProjectExcluding(GUEST, "proj-other"),
    ).resolves.toBe(true);
    expect(await findUserDefaultProject(GUEST, OTHER_ORG)).not.toBeNull();
  });
});

describe("listUserOrganizations", () => {
  it("returns every org the caller actively belongs to, with their role", async () => {
    seedOrgWithMember(GUEST, "admin");
    seedOtherOrgWithMember(GUEST, "member");

    const rows = await listUserOrganizations(GUEST);
    expect(rows.map((r) => r.id).sort()).toEqual([OTHER_ORG, ORG].sort());
    expect(rows.find((r) => r.id === ORG)?.role).toBe("admin");
  });

  it("omits a suspended membership — a switch there would resolve nothing", async () => {
    seedOrgWithMember(GUEST);
    seedOtherOrgWithMember(GUEST);
    const row = store.members.find((m) => m.organizationId === OTHER_ORG);
    if (row) row.status = "suspended";

    const rows = await listUserOrganizations(GUEST);
    expect(rows.map((r) => r.id)).toEqual([ORG]);
  });

  it("never returns an org the caller has no membership in", async () => {
    seedOrgWithMember(GUEST);
    store.orgs.push({ id: OTHER_ORG, slug: "other", name: "Other" });
    store.members.push({
      organizationId: OTHER_ORG,
      userId: HOST,
      userEmail: "host@example.com",
      role: "owner",
    });

    const rows = await listUserOrganizations(GUEST);
    expect(rows.map((r) => r.id)).toEqual([ORG]);
  });
});

describe("findUserDefaultProject strict mode (the org switcher's contract)", () => {
  it("returns null rather than another org's project when strict", async () => {
    // The bug this exists to prevent: selecting an org you hold no project in
    // silently resolved your DEFAULT org's project, so the switcher said one
    // org while every page read from another.
    seedOrgWithMember(GUEST);
    seedOtherOrgWithMember(GUEST);
    seedProjectIn("proj-host", ORG, GUEST);
    // No project at all in OTHER_ORG.

    await expect(
      findUserDefaultProject(GUEST, OTHER_ORG, false),
    ).resolves.toMatchObject({ id: "proj-host" });
    await expect(
      findUserDefaultProject(GUEST, OTHER_ORG, true),
    ).resolves.toBeNull();
  });

  it("still answers normally when the selected org DOES have a project", async () => {
    seedOrgWithMember(GUEST);
    seedOtherOrgWithMember(GUEST);
    seedProjectIn("proj-host", ORG, GUEST);
    seedProjectIn("proj-other", OTHER_ORG, GUEST);

    await expect(
      findUserDefaultProject(GUEST, OTHER_ORG, true),
    ).resolves.toMatchObject({ id: "proj-other" });
  });

  it("leaves the no-preference path unfenced — the lockout guard is untouched", async () => {
    // strict only applies alongside an explicit preference. Without one the
    // old behaviour must stand, or deleting a last project locks the user out.
    seedOrgWithMember(GUEST);
    seedProjectIn("proj-host", ORG, GUEST);

    await expect(findUserDefaultProject(GUEST)).resolves.toMatchObject({
      id: "proj-host",
    });
    await expect(
      findUserDefaultProject(GUEST, undefined, true),
    ).resolves.toMatchObject({ id: "proj-host" });
  });
});

describe("attachMemberToProject", () => {
  const INVITEE = "user-invitee";

  it("binds the invitee to the org's OLDEST project instead of creating one", async () => {
    // The behaviour change: an org used to gain a project per invited member.
    seedOrgWithMember(GUEST);
    store.members.push({
      organizationId: ORG,
      userId: INVITEE,
      userEmail: "invitee@example.com",
      role: "member",
    });
    seedProjectIn("proj-old", ORG, GUEST);
    seedProjectIn("proj-new", ORG, GUEST);

    const before = store.projects.length;
    const result = await attachMemberToProject(
      ORG,
      INVITEE,
      "invitee@example.com",
    );

    expect(result.id).toBe("proj-old");
    expect(store.projects).toHaveLength(before);
    expect(
      store.bindings.some(
        (b) => b.projectId === "proj-old" && b.userId === INVITEE,
      ),
    ).toBe(true);
  });

  it("honours the project the inviter chose", async () => {
    seedOrgWithMember(GUEST);
    store.members.push({
      organizationId: ORG,
      userId: INVITEE,
      userEmail: "invitee@example.com",
      role: "member",
    });
    seedProjectIn("proj-old", ORG, GUEST);
    seedProjectIn("proj-chosen", ORG, GUEST);

    const result = await attachMemberToProject(
      ORG,
      INVITEE,
      "invitee@example.com",
      "proj-chosen",
    );
    expect(result.id).toBe("proj-chosen");
  });

  it("falls back to the oldest when the chosen project is gone or foreign", async () => {
    // A project deleted between invite and accept must not fail the accept,
    // and a cross-org id must not reach out of the organization.
    seedOrgWithMember(GUEST);
    seedOtherOrgWithMember(GUEST);
    store.members.push({
      organizationId: ORG,
      userId: INVITEE,
      userEmail: "invitee@example.com",
      role: "member",
    });
    seedProjectIn("proj-old", ORG, GUEST);
    seedProjectIn("proj-foreign", OTHER_ORG, GUEST);

    await expect(
      attachMemberToProject(ORG, INVITEE, "i@e.com", "proj-deleted"),
    ).resolves.toMatchObject({ id: "proj-old" });
    await expect(
      attachMemberToProject(ORG, INVITEE, "i@e.com", "proj-foreign"),
    ).resolves.toMatchObject({ id: "proj-old" });
  });

  it("is idempotent — a second accept re-uses the reachable project", async () => {
    seedOrgWithMember(GUEST);
    store.members.push({
      organizationId: ORG,
      userId: INVITEE,
      userEmail: "invitee@example.com",
      role: "member",
    });
    seedProjectIn("proj-old", ORG, GUEST);

    await attachMemberToProject(ORG, INVITEE, "i@e.com");
    const bindings = store.bindings.length;
    const again = await attachMemberToProject(ORG, INVITEE, "i@e.com");

    expect(again.id).toBe("proj-old");
    expect(store.bindings).toHaveLength(bindings);
  });

  it("still creates a project when the organization has none at all", async () => {
    // The bootstrap edge — an org whose every project was deleted.
    seedOrgWithMember(GUEST);
    store.members.push({
      organizationId: ORG,
      userId: INVITEE,
      userEmail: "invitee@example.com",
      role: "member",
    });

    const result = await attachMemberToProject(ORG, INVITEE, "i@e.com");
    expect(result.organizationId).toBe(ORG);
    expect(store.projects).toHaveLength(1);
  });
});

describe("validateOrgName", () => {
  it("trims and returns the name", () => {
    expect(validateOrgName("  Acme  ")).toBe("Acme");
  });

  it("rejects empty, whitespace-only and overlong names as UNPROCESSABLE", () => {
    for (const raw of ["", "   ", "x".repeat(256)]) {
      // A plain Error here would surface as a 500 rather than the 422 a bad
      // name deserves — the code is the contract, not just the throw.
      expect(() => validateOrgName(raw)).toThrow(ServiceError);
      try {
        validateOrgName(raw);
      } catch (err) {
        expect((err as ServiceError).code).toBe("UNPROCESSABLE");
      }
    }
  });

  it("accepts a name at exactly the 255-char ceiling", () => {
    expect(validateOrgName("x".repeat(255))).toHaveLength(255);
  });
});

describe("renameOrganization", () => {
  it("renames and returns id/name/slug", async () => {
    seedOrgWithMember(GUEST, "admin");
    const row = await renameOrganization(ORG, "Renamed");
    expect(row).toEqual({ id: ORG, name: "Renamed", slug: "host" });
    expect(store.orgs.find((o) => o.id === ORG)?.name).toBe("Renamed");
  });

  it("trims the name before storing", async () => {
    seedOrgWithMember(GUEST, "admin");
    await renameOrganization(ORG, "  Padded  ");
    expect(store.orgs.find((o) => o.id === ORG)?.name).toBe("Padded");
  });

  it("never touches slug — it is globally unique AND read by the onprem bootstrap", async () => {
    seedOrgWithMember(GUEST, "admin");
    await renameOrganization(ORG, "Renamed");
    expect(store.orgs.find((o) => o.id === ORG)?.slug).toBe("host");
  });

  it("404s a vanished organization instead of 500ing", async () => {
    await expect(
      renameOrganization("org-gone", "Renamed"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("422s an invalid name before writing anything", async () => {
    seedOrgWithMember(GUEST, "admin");
    await expect(renameOrganization(ORG, "   ")).rejects.toMatchObject({
      code: "UNPROCESSABLE",
    });
    expect(store.orgs.find((o) => o.id === ORG)?.name).toBe("Host");
  });
});

describe("requireOrgAdmin", () => {
  it("passes an admin and an owner", async () => {
    seedOrgWithMember(GUEST, "admin");
    await expect(requireOrgAdmin(GUEST, ORG)).resolves.toBeUndefined();

    const row = store.members.find((m) => m.userId === GUEST);
    if (row) row.role = "owner";
    await expect(requireOrgAdmin(GUEST, ORG)).resolves.toBeUndefined();
  });

  it("denies a plain member", async () => {
    seedOrgWithMember(GUEST, "member");
    await expect(requireOrgAdmin(GUEST, ORG)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("denies a non-member", async () => {
    seedOrgWithMember(HOST, "owner");
    await expect(requireOrgAdmin(GUEST, ORG)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("denies a SUSPENDED admin — suspended reads as no role", async () => {
    seedOrgWithMember(GUEST, "admin");
    const row = store.members.find((m) => m.userId === GUEST);
    if (row) row.status = "suspended";
    await expect(requireOrgAdmin(GUEST, ORG)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("fails CLOSED when no role resolver is registered", async () => {
    seedOrgWithMember(GUEST, "owner");
    store.roleResolver = null;
    await expect(requireOrgAdmin(GUEST, ORG)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
