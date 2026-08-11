import { db } from "@onecli/db";
import { generateApiKey, ensureBootstrapOrgApiKey } from "./api-key-service";
import { generateAccessToken } from "./agent-service";
import { DEFAULT_AGENT_NAME, DEFAULT_AGENT_IDENTIFIER } from "../lib/constants";
import { generateProjectId, generateOrganizationId } from "../lib/ids";
import {
  getNewOrgPolicySeeder,
  getRoleResolver,
  ROLE_HIERARCHY,
} from "../providers";
import { logger } from "../lib/logger";
import { ServiceError } from "./errors";

export const slugify = (raw: string) =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * Membership filter every ACCESS-GRANTING read applies: suspended members are
 * treated as non-members by all authorization checks. Live in OSS as well as
 * cloud — `PATCH /v1/org/members/:userId` is the OSS write-side, so a suspended
 * row is a state this edition really reaches. Deliberately NOT applied to
 * display lists, seat counts, or the provisioning/JIT existence guards —
 * filtering those would re-mint memberships for suspended users.
 */
export const activeMembershipWhere = {
  status: { not: "suspended" },
} as const;

/**
 * Resolve the user's default project: first organization → first project.
 * Returns null when the user has no organization or no project (pre-bootstrap).
 *
 * Used by `resolveUser()`, `resolveApiAuth()`, and the session route to map
 * an authenticated user to a project without creating anything.
 *
 * Two arms, in order — both scoped to orgs the user is an ACTIVE member of:
 *  1. the oldest project the user CREATED. Searched across every active
 *     membership, not just the first one: a user who was invited to someone
 *     else's org and later bootstrapped their own would otherwise resolve to
 *     the older foreign org, and their OWN project would be shadowed by a
 *     project they were merely shared into.
 *  2. otherwise the oldest project they hold a `ProjectAccess` binding on
 *     (directly or through a group). Without this an INVITED member — who
 *     creates nothing — resolves to no project at all: session auth then
 *     demands an `X-Organization-Id` header that OSS never sends (401
 *     everywhere) and `resolveProjectContext` throws. The binding is the same
 *     gate `canAccessProjectAsUser` applies, so this arm can only ever return
 *     a project the user may actually use.
 *
 * Both arms tiebreak on `id` so a `createdAt` collision (two projects seeded in
 * the same millisecond) resolves deterministically instead of leaving the
 * caller's project up to the query planner.
 */
export const findUserDefaultProject = async (
  userId: string,
  preferredOrgId?: string,
  /**
   * Refuse to look outside `preferredOrgId`.
   *
   * The unfenced fallback exists so an unusable SELECTION never strands a
   * caller with no project at all. But when the org was chosen EXPLICITLY (the
   * switcher's header), silently answering with another org's project is worse
   * than answering with none: the switcher says one org while every page reads
   * from another. "No project in this organization" is a legitimate state —
   * `session.ts` still resolves org context via `resolveOrganizationId`, so
   * this returns null without a lockout.
   */
  strict = false,
): Promise<{ id: string; organizationId: string } | null> => {
  // Cheap early-out for the pre-bootstrap user, and the reason both arms below
  // can assume at least one active membership exists.
  const membership = await db.organizationMember.findFirst({
    where: { userId, ...activeMembershipWhere },
    select: { organizationId: true },
    orderBy: { createdAt: "asc" },
  });
  if (!membership) return null;

  const inActiveMemberOrg = {
    organization: { members: { some: { userId, ...activeMembershipWhere } } },
  };

  // Both arms, optionally fenced to one organization. `preferredOrgId` is the
  // org switcher's selection: it NARROWS which projects are candidates, it
  // never widens them — the active-membership fence still applies, so an org
  // the caller does not belong to simply yields nothing and we fall through to
  // the unfenced pass below.
  const resolve = async (organizationId?: string) => {
    const orgFence = organizationId ? { organizationId } : {};
    const created = await db.project.findFirst({
      where: { ...inActiveMemberOrg, ...orgFence, createdByUserId: userId },
      select: { id: true, organizationId: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (created) return created;

    return db.project.findFirst({
      where: {
        ...inActiveMemberOrg,
        ...orgFence,
        accessBindings: {
          some: {
            OR: [{ userId }, { group: { members: { some: { userId } } } }],
          },
        },
      },
      select: { id: true, organizationId: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  };

  // A selection that resolves nothing (org left, membership suspended, its
  // last project deleted) must not strand the caller with no project at all —
  // that is the lockout `hasResolvableProjectExcluding` exists to prevent. Fall
  // back to the unfenced answer, which is exactly the pre-switcher behaviour.
  if (preferredOrgId) {
    const preferred = await resolve(preferredOrgId);
    if (preferred) return preferred;
    if (strict) return null;
  }
  return resolve();
};

/**
 * Whether `userId` would still resolve SOME project if `excludeProjectId`
 * disappeared — the delete guard's lockout oracle
 * (`deleteProject`, project-service).
 *
 * Deliberately takes NO `preferredOrgId`. The org fence in
 * `findUserDefaultProject` only ever narrows, and always falls back to the
 * unfenced answer, so the set of projects that can EVER resolve is unchanged —
 * which is precisely the set this predicate has to describe. Adding a fence
 * here would make it answer a narrower question than the one the delete guard
 * asks ("will this user resolve SOMETHING afterwards?") and reintroduce the
 * lockout.
 *
 * THESE TWO MUST AGREE: this is exactly `findUserDefaultProject`'s disjunction
 * (created-by-them, OR bound directly / through a group), fenced to orgs the
 * user is an ACTIVE member of, minus the project about to be deleted. It lives
 * here rather than in project-service precisely so the two predicates stay in
 * sync — drift between them is a lockout: a user whose last project is deleted
 * resolves no project at all, and session auth then 401s them everywhere.
 *
 * Both arms are folded into one `OR` (unlike the ordered two-query fallback
 * above) because only existence matters here, never which project wins.
 */
export const hasResolvableProjectExcluding = async (
  userId: string,
  excludeProjectId: string,
): Promise<boolean> => {
  const inActiveMemberOrg = {
    organization: { members: { some: { userId, ...activeMembershipWhere } } },
  };

  const row = await db.project.findFirst({
    where: {
      ...inActiveMemberOrg,
      id: { not: excludeProjectId },
      OR: [
        { createdByUserId: userId },
        {
          accessBindings: {
            some: {
              OR: [{ userId }, { group: { members: { some: { userId } } } }],
            },
          },
        },
      ],
    },
    select: { id: true },
  });

  return row !== null;
};

/**
 * The nested-write seeds every user-facing project is born with: one API
 * key + the default agent. The single definition all provision sites
 * spread into their `project.create` data (bootstrap, project creation,
 * membership provisioning) — the guarded split-write variant for existing
 * projects is `ensureProjectSeeds` below.
 */
export const defaultProjectSeed = (userId: string, userEmail: string) => ({
  apiKeys: { create: { key: generateApiKey(), userId, userEmail } },
  agents: {
    create: {
      name: DEFAULT_AGENT_NAME,
      identifier: DEFAULT_AGENT_IDENTIFIER,
      accessToken: generateAccessToken(),
      isDefault: true,
      // Attach-model step 5: every new agent starts selective with nothing
      // attached — credentials arrive through explicit grants. Explicit at
      // every creation site because the schema default stays "all" until the
      // column retires (step 8).
      secretMode: "selective",
    },
  },
});

/**
 * Create an organization with a default project, API key, and default agent
 * for a user who has no organization yet. Returns the created project.
 *
 * This is the single source of truth for the "first login" bootstrap flow.
 * Called by:
 *   - `GET /v1/auth/session` (cloud + OSS)
 *   - `ensureLocalUser()` (OSS local-auth mode)
 *   - `ensureUserDefaultOrgAndProject()` (EE project management)
 */
export const bootstrapOrganization = async (
  userId: string,
  userEmail: string,
  displayName?: string,
) => {
  const orgName = displayName || userEmail.split("@")[0] || "Personal";
  const baseSlug = slugify(orgName) || "personal";
  const orgSlug = `${baseSlug}-${userId.slice(0, 8)}`;

  const org = await db.organization.create({
    data: {
      id: generateOrganizationId(),
      name: orgName,
      slug: orgSlug,
      members: { create: { userId, userEmail, role: "owner" } },
    },
    select: { id: true },
  });

  const project = await db.project.create({
    data: {
      id: generateProjectId(),
      name: "Default",
      slug: "default",
      organizationId: org.id,
      createdByUserId: userId,
      createdByUserEmail: userEmail,
      ...defaultProjectSeed(userId, userEmail),
      // Creator's ProjectAccess binding (step 13), seeded owner (13c) with the
      // project. Load-bearing in every rbac edition, OSS included: without it a
      // non-admin member is denied their own project by `canAccessProjectAsUser`.
      accessBindings: { create: { userId, role: "owner" } },
    },
    select: { id: true, organizationId: true },
  });

  // Seed the new org's initial published policy (cloud: an allow-posture org
  // Default Rule). Best-effort — a hiccup must not fail onboarding; the org then
  // has no published generation and the engine allows until one is authored. OSS
  // default is a no-op.
  try {
    await getNewOrgPolicySeeder().seed(org.id, project.id);
  } catch (err) {
    logger.warn({ err, organizationId: org.id }, "new-org policy seed failed");
  }

  return { project, organization: org };
};

/** The single shared organization for onprem (`single-org-shared` tenancy). */
export const SHARED_ORG_SLUG = "default";
export const SHARED_ORG_NAME = "Default";

/**
 * Find-or-create the single shared organization. The slug is `@unique`, so a
 * concurrent first-login race resolves to one org — the create loser catches the
 * unique violation and re-reads.
 */
const findOrCreateSharedOrg = async (): Promise<{ id: string }> => {
  const existing = await db.organization.findUnique({
    where: { slug: SHARED_ORG_SLUG },
    select: { id: true },
  });
  if (existing) return existing;
  try {
    return await db.organization.create({
      data: {
        id: generateOrganizationId(),
        name: SHARED_ORG_NAME,
        slug: SHARED_ORG_SLUG,
      },
      select: { id: true },
    });
  } catch {
    return db.organization.findUniqueOrThrow({
      where: { slug: SHARED_ORG_SLUG },
      select: { id: true },
    });
  }
};

/**
 * The ORG-LEVEL part of the onprem bootstrap: ensure the single shared
 * organization exists, the user is a member, and the operator bootstrap org API
 * key is seeded — WITHOUT any project. Idempotent and concurrency-safe. Shared by
 * `joinSharedOrganization` (first login) and the eager boot-time init, which
 * provisions just the org + key so the instance is usable via the org key before
 * anyone opens the web.
 */
export const ensureSharedOrgWithKey = async (
  userId: string,
  userEmail: string,
): Promise<{ id: string }> => {
  const org = await findOrCreateSharedOrg();

  // Add the user to the shared org (idempotent on the composite PK).
  await db.organizationMember.upsert({
    where: { organizationId_userId: { organizationId: org.id, userId } },
    create: { organizationId: org.id, userId, userEmail, role: "owner" },
    update: {},
  });

  // Ensure the shared org's bootstrap API key exists (operator-supplied via
  // ONECLI_ORG_API_KEY / _FILE, else generated). Idempotent — no-ops once seeded.
  await ensureBootstrapOrgApiKey({ organizationId: org.id, userId, userEmail });

  // Seed the shared org's initial published policy (step 9.5 — onprem rides
  // the EE engine, so a fresh instance starts on v2 directly). Best-effort +
  // idempotent, like the per-user-org bootstrap above.
  try {
    await getNewOrgPolicySeeder().seed(org.id);
  } catch (err) {
    logger.warn(
      { err, organizationId: org.id },
      "shared-org policy seed failed",
    );
  }

  return org;
};

/**
 * Single-org (onprem) first-login bootstrap: ensure the shared org + operator key
 * (via `ensureSharedOrgWithKey`), then give the user their own default project
 * inside it. Idempotent and concurrency-safe. Mirrors `bootstrapOrganization`'s
 * return shape — the project apiKey + default agent are seeded by the caller's
 * `ensureProjectSeeds`.
 */
export const joinSharedOrganization = async (
  userId: string,
  userEmail: string,
) => {
  const org = await ensureSharedOrgWithKey(userId, userEmail);

  // Each user gets their own default project in the shared org. The project slug
  // must be unique per org (`@@unique([organizationId, slug])`); since every user
  // shares this one org (unlike the per-user orgs in `bootstrapOrganization`), use
  // the full user id so the slug can never collide.
  let project = await db.project.findFirst({
    where: { organizationId: org.id, createdByUserId: userId },
    select: { id: true, organizationId: true },
    orderBy: { createdAt: "asc" },
  });
  if (!project) {
    project = await db.project.create({
      data: {
        id: generateProjectId(),
        name: "Default",
        slug: `default-${userId}`,
        organizationId: org.id,
        createdByUserId: userId,
        createdByUserEmail: userEmail,
        // Creator's ProjectAccess binding (step 13), seeded owner (13c) — the
        // member's own usage gate wherever rbac is on.
        accessBindings: { create: { userId, role: "owner" } },
      },
      select: { id: true, organizationId: true },
    });
    // Seed the new project's initial published policy (step 9.5) — a no-op
    // for the org-scope EE seeder (idempotent on the org's existing
    // generation), load-bearing where the seeder is project-scoped.
    try {
      await getNewOrgPolicySeeder().seed(org.id, project.id);
    } catch (err) {
      logger.warn(
        { err, organizationId: org.id, projectId: project.id },
        "shared-org project policy seed failed",
      );
    }
  }

  return { project, organization: org };
};

/**
 * Give a member their own default project inside an EXISTING organization —
 * the invited-member counterpart to `bootstrapOrganization` (which creates the
 * org too). Find-or-create and therefore idempotent.
 *
 * The `accessBindings` row is load-bearing, not decoration: with `CAPS.rbac`
 * on, a plain member reaches a project only as an org admin/owner or through a
 * ProjectAccess binding (`canAccessProjectAsUser`). Creating the project
 * without the binding would hand the member a project they are then denied
 * access to on every request.
 *
 * The project slug is unique per org (`@@unique([organizationId, slug])`), and
 * an existing org already owns the plain `default` slug, so the member's slug
 * carries their user id.
 */
/**
 * Give an invited member a project to land on, by ATTACHING them to an existing
 * one rather than minting a personal one.
 *
 * The old behaviour (`ensureMemberDefaultProject`) created a project named
 * "Default" per invitee, slug `default-<userId>`. That is why project names are
 * deliberately non-unique per org, and why an org accumulated one project per
 * person while nobody landed anywhere shared.
 *
 * Resolution order:
 *  1. A project the member can ALREADY reach — created by them, or bound
 *     directly/through a group. Keeps accept idempotent and never re-binds on a
 *     second click.
 *  2. `preferredProjectId`, when the inviter chose one and it is still in this
 *     org. Silently ignored otherwise: a project deleted between invite and
 *     accept must not fail the accept.
 *  3. The organization's OLDEST project — its de-facto default. Deterministic,
 *     and the same ordering `findUserDefaultProject` uses.
 *  4. Only if the org has no project at all: create one. This is the bootstrap
 *     edge (an org whose every project was deleted), not the common path.
 *
 * The binding is `member`, never `owner`: being invited grants use of a
 * project, not authority over it. An org admin already has management authority
 * through their role.
 */
export const attachMemberToProject = async (
  organizationId: string,
  userId: string,
  userEmail: string,
  preferredProjectId?: string | null,
) => {
  // 1. Already reachable — the idempotent path.
  const reachable = await db.project.findFirst({
    where: {
      organizationId,
      OR: [
        { createdByUserId: userId },
        {
          accessBindings: {
            some: {
              OR: [{ userId }, { group: { members: { some: { userId } } } }],
            },
          },
        },
      ],
    },
    select: { id: true, organizationId: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (reachable) return reachable;

  // 2/3. The chosen project if it still belongs to this org, else the oldest.
  const target =
    (preferredProjectId
      ? await db.project.findFirst({
          where: { id: preferredProjectId, organizationId },
          select: { id: true, organizationId: true },
        })
      : null) ??
    (await db.project.findFirst({
      where: { organizationId },
      select: { id: true, organizationId: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }));

  if (target) {
    // `createMany` + skipDuplicates rather than `create`: two accepts racing on
    // the same invitation must not collide on @@unique([projectId, userId]).
    await db.projectAccess.createMany({
      data: [{ projectId: target.id, userId, role: "member" }],
      skipDuplicates: true,
    });
    return target;
  }

  // 4. Bootstrap edge only: an organization with no projects at all.
  const project = await db.project.create({
    data: {
      id: generateProjectId(),
      name: "Default",
      slug: `default-${userId}`,
      organizationId,
      createdByUserId: userId,
      createdByUserEmail: userEmail,
      ...defaultProjectSeed(userId, userEmail),
      accessBindings: { create: { userId, role: "owner" } },
    },
    select: { id: true, organizationId: true },
  });

  // Best-effort, exactly as the other provision sites: a seeding hiccup must
  // not fail the member's first login.
  try {
    await getNewOrgPolicySeeder().seed(organizationId, project.id);
  } catch (err) {
    logger.warn(
      { err, organizationId, projectId: project.id },
      "member project policy seed failed",
    );
  }

  return project;
};

export const validateOrgName = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 255) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "Organization name must be 1-255 characters",
    );
  }
  return trimmed;
};

/**
 * Ensure a project has an API key for the given user and a default agent.
 * Idempotent — skips creation if they already exist.
 */
export const ensureProjectSeeds = async (
  projectId: string,
  userId: string,
  userEmail: string,
) => {
  const hasKey = await db.apiKey.findFirst({
    where: { userId, projectId },
    select: { id: true },
  });
  if (!hasKey) {
    await db.apiKey.create({
      data: { key: generateApiKey(), userId, userEmail, projectId },
    });
  }

  const hasDefaultAgent = await db.agent.findFirst({
    where: { projectId, isDefault: true },
    select: { id: true },
  });
  if (!hasDefaultAgent) {
    await db.agent.create({
      data: {
        name: DEFAULT_AGENT_NAME,
        identifier: DEFAULT_AGENT_IDENTIFIER,
        accessToken: generateAccessToken(),
        isDefault: true,
        secretMode: "selective",
        projectId,
      },
    });
  }
};

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  role: string;
}

/**
 * Organizations the caller is an ACTIVE member of, oldest membership first —
 * the org switcher's source.
 *
 * Fenced by `activeMembershipWhere` for the usual reason: a suspended member is
 * a non-member to every authorization check, so listing their old org would
 * offer a switch that resolves to nothing.
 *
 * Multi-org membership is ordinary here, not exotic: `bootstrapOrganization`
 * gives every user their own org as `owner`, and accepting an invitation adds a
 * membership in someone else's — so anyone who has accepted an invite belongs
 * to at least two.
 */
export const listUserOrganizations = async (
  userId: string,
): Promise<OrganizationRow[]> => {
  const rows = await db.organizationMember.findMany({
    where: { userId, ...activeMembershipWhere },
    select: {
      role: true,
      organization: { select: { id: true, name: true, slug: true } },
    },
    orderBy: [{ createdAt: "asc" }],
  });

  return rows.map((row) => ({
    id: row.organization.id,
    name: row.organization.name,
    slug: row.organization.slug,
    role: row.role,
  }));
};

/**
 * ADMIN authority over the organization itself — the per-resource check the
 * `/v1/organizations` router needs, because it cannot take a `role: "admin"`
 * filter globally: `GET /` is deliberately member-visible.
 *
 * Same two invariants as `resolveAuthority` in `project-service`:
 *
 *  - The role is resolved FIRST and a null role denies (the suspension
 *    invariant): `ossRoleResolver` reads a suspended membership as no role, so
 *    a suspended admin cannot rename the org.
 *  - Deliberately NOT gated on `CAPS.rbac`. A usage check must no-op (allow)
 *    for editions without roles; a MANAGEMENT check that allowed everyone
 *    there would let any member rename the organization. With no resolver
 *    registered the role reads null and we deny — fail closed.
 */
export const requireOrgAdmin = async (
  userId: string,
  organizationId: string,
): Promise<void> => {
  const resolver = getRoleResolver();
  const role = resolver
    ? await resolver.getUserRole(userId, organizationId)
    : null;
  if (!role || ROLE_HIERARCHY[role] < ROLE_HIERARCHY.admin) {
    throw new ServiceError(
      "FORBIDDEN",
      "You do not have permission to manage this organization.",
    );
  }
};

/**
 * Rename. `name` ONLY — `slug` is strictly immutable, and more so than a
 * project's: `Organization.slug` is GLOBALLY `@unique`, and unlike a project's
 * it IS read — `findOrCreateSharedOrg` looks the onprem bootstrap org up by
 * `SHARED_ORG_SLUG`. Rewriting it could both collide and strand that lookup.
 * Names are NOT unique across orgs (see `orgNameSchema`), so a rename-to-self
 * and a rename onto another org's name are both permitted 200s.
 */
export const renameOrganization = async (
  organizationId: string,
  name: string,
): Promise<Omit<OrganizationRow, "role">> => {
  const trimmed = validateOrgName(name);

  // Conditional write, mirroring `renameProject`: count 0 means the row
  // vanished between authorization and the write — 404, not a 500.
  const { count } = await db.organization.updateMany({
    where: { id: organizationId },
    data: { name: trimmed },
  });
  if (count === 0) {
    throw new ServiceError("NOT_FOUND", "Organization not found.");
  }

  const row = await db.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, name: true, slug: true },
  });
  if (!row) throw new ServiceError("NOT_FOUND", "Organization not found.");
  return row;
};
