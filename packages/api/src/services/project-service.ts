import { db } from "@onecli/db";
import { ServiceError } from "./errors";
import {
  getRoleResolver,
  ROLE_HIERARCHY,
  getNewOrgPolicySeeder,
} from "../providers";
import {
  activeMembershipWhere,
  defaultProjectSeed,
  hasResolvableProjectExcluding,
  slugify,
} from "./organization-service";
import { generateProjectId } from "../lib/ids";
import { logger } from "../lib/logger";
import { MAX_PROJECTS_PER_ORG } from "../validations/project";
import { invalidateGatewayCacheForKeys } from "../lib/gateway-invalidate";
import { CAPS } from "../lib/env";

// Project administration: read, rename, delete. Three rules, same as
// `org-group-service.ts`:
//   1. every resolve is `findFirst({ id, organizationId })`, NEVER
//      `findUnique({ where: { id } })` — a cross-org id must read as absent
//      (404), not leak another org's row;
//   2. the organization id ALWAYS comes from `auth.organizationId`, never from
//      a body or query parameter;
//   3. writes are conditional `updateMany`/`deleteMany` so a lost race is a
//      404, not the P2025 500 a bare `update()`/`delete()` would surface.

/** A project row in the client's `Project` shape (`createdAt` as ISO string). */
export interface ProjectRow {
  id: string;
  name: string | null;
  slug: string | null;
  createdAt: string;
}

/** What a delete actually removed. */
export interface ProjectDeleteResult {
  id: string;
  name: string | null;
  removed: {
    agents: number;
    apiKeys: number;
    secrets: number;
    policyRules: number;
    policyRulesV2: number;
    appConnections: number;
    appConfigs: number;
    vaultConnections: number;
    budgets: number;
    accessBindings: number;
    onboardingSurvey: number;
  };
}

const projectSelect = {
  id: true,
  name: true,
  slug: true,
  createdAt: true,
  createdByUserId: true,
} as const;

const toProjectRow = (row: {
  id: string;
  name: string | null;
  slug: string | null;
  createdAt: Date;
}): ProjectRow => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Resolve a project WITHIN the caller's org. A cross-org (or unknown) id reads
 * as absent — 404, never 403: a forbidden response would turn the route into an
 * existence oracle for another organization's project ids.
 */
export const requireProject = async (
  organizationId: string,
  projectId: string,
) => {
  const project = await db.project.findFirst({
    where: { id: projectId, organizationId },
    select: projectSelect,
  });
  if (!project) throw new ServiceError("NOT_FOUND", "Project not found.");
  return project;
};

export interface ProjectAuthority {
  /** Org admin/owner — Guard H's exemption in `setProjectAccess`. */
  isOrgAdmin: boolean;
  canManage: boolean;
}

/**
 * MANAGEMENT authority over a project (step 13c): an org admin/owner, or the
 * holder of a USER binding with `role: "owner"`. GROUP bindings never confer
 * management in v1 — the gateway and the usage gate both ignore `role`, so a
 * group grant is a USE grant only.
 *
 * Resolves the org role ONCE and derives both signals from it, so a route never
 * pays for (or risks disagreeing across) two resolver calls.
 *
 * Two invariants, both deliberate:
 *
 *  - The role is resolved FIRST and a null role denies (the suspension
 *    invariant, copied from `canAccessProjectAsUser`): the binding check lives
 *    INSIDE the active-member gate, so a suspended user's stale owner binding
 *    can never rescue them.
 *  - Unlike `canAccessProjectAsUser`, this is NOT gated on `CAPS.rbac`. A usage
 *    check must no-op (allow) for editions without roles; a MANAGEMENT check
 *    that allowed everyone there would let any member delete any project. With
 *    no resolver registered the role reads null and we deny — fail closed.
 */
const resolveAuthority = async (
  userId: string,
  organizationId: string,
  projectId: string,
): Promise<ProjectAuthority> => {
  const resolver = getRoleResolver();
  const role = resolver
    ? await resolver.getUserRole(userId, organizationId)
    : null;
  if (!role) return { isOrgAdmin: false, canManage: false };
  if (ROLE_HIERARCHY[role] >= ROLE_HIERARCHY.admin) {
    return { isOrgAdmin: true, canManage: true };
  }

  const owner = await db.projectAccess.findFirst({
    where: { projectId, userId, role: "owner" },
    select: { id: true },
  });
  return { isOrgAdmin: false, canManage: owner !== null };
};

export const canManageProject = async (
  userId: string,
  organizationId: string,
  projectId: string,
): Promise<boolean> =>
  (await resolveAuthority(userId, organizationId, projectId)).canManage;

/** Route helper: resolve (404) THEN authorize (403), never the other way —
 * a cross-org project id must never distinguish "exists but forbidden". */
export const requireManageableProject = async (
  organizationId: string,
  userId: string,
  projectId: string,
) => {
  const project = await requireProject(organizationId, projectId);
  const authority = await resolveAuthority(userId, organizationId, projectId);
  if (!authority.canManage) {
    throw new ServiceError(
      "FORBIDDEN",
      "You do not have permission to manage this project.",
    );
  }
  return { project, isOrgAdmin: authority.isOrgAdmin };
};

export const getProject = async (
  organizationId: string,
  projectId: string,
): Promise<ProjectRow> =>
  toProjectRow(await requireProject(organizationId, projectId));

const listAllProjects = async (organizationId: string): Promise<ProjectRow[]> =>
  (
    await db.project.findMany({
      where: { organizationId },
      select: projectSelect,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
  ).map(toProjectRow);

/**
 * Every project in `organizationId` the caller may USE, oldest first.
 *
 * THIS MUST MIRROR `canAccessProjectAsUser` — it is that per-row predicate
 * expressed as a query, arm for arm, and the two are required to agree. Drift
 * either way is a bug with teeth: a project listed here but rejected by the
 * usage gate leaks a name past its ProjectAccess bindings, and one allowed
 * there but omitted here is a project the caller can reach but never discover.
 *
 * The arms, in the same order and for the same reasons as the gate:
 *
 *  1. No RBAC — the gate no-ops (allows), so the list is the whole org.
 *  2. No role — suspended or not a member. Empty, and the binding arm is
 *     INSIDE this gate, so a suspended user's stale binding is never consulted
 *     (the suspension invariant).
 *  3. Admin/owner — the whole org.
 *  4. Otherwise — projects carrying a binding for this user, direct or through
 *     a group. `role` is deliberately not filtered: usage is role-blind, and a
 *     plain `member` binding is a full use grant.
 *
 * Ordering matches `findUserDefaultProject` (`createdAt asc, id asc`) so the
 * project a caller lands on by default is the first one a switcher shows.
 */
export const listProjects = async (
  organizationId: string,
  userId: string,
): Promise<ProjectRow[]> => {
  if (!CAPS.rbac) return listAllProjects(organizationId);

  const resolver = getRoleResolver();
  const role = resolver
    ? await resolver.getUserRole(userId, organizationId)
    : null;
  if (!role) return [];
  if (ROLE_HIERARCHY[role] >= ROLE_HIERARCHY.admin) {
    return listAllProjects(organizationId);
  }

  return (
    await db.project.findMany({
      where: {
        organizationId,
        accessBindings: {
          some: {
            OR: [{ userId }, { group: { members: { some: { userId } } } }],
          },
        },
      },
      select: projectSelect,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
  ).map(toProjectRow);
};

/** Prisma's unique-constraint code, same test as `org-group-service.ts`. */
const isUniqueViolation = (err: unknown) =>
  typeof err === "object" &&
  err !== null &&
  (err as { code?: string }).code === "P2002";

/**
 * A free slug for `name` within the org. Slugs are
 * `@@unique([organizationId, slug])` but project NAMES are deliberately not
 * unique (see `projectNameSchema`), so a collision here is an ordinary,
 * expected state — never a user-facing error. Disambiguate silently.
 */
const freeSlug = async (
  organizationId: string,
  name: string,
): Promise<string> => {
  const base = slugify(name) || "project";
  const taken = new Set(
    (
      await db.project.findMany({
        where: { organizationId, slug: { startsWith: base } },
        select: { slug: true },
      })
    ).map((row) => row.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n <= taken.size + 2; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Unreachable by construction (the loop bound exceeds the taken set), but a
  // random tail is a safer fallback than throwing on a naming detail.
  return `${base}-${generateProjectId().slice(0, 8)}`;
};

/**
 * Create a project, with the caller as its `owner`.
 *
 * The owner binding is a NESTED create, not a follow-up write, so it lands in
 * the same statement as the project row. That is Guard G's precondition: a
 * project with no owner binding can never be renamed, shared or deleted by
 * anyone but an org admin, so a create that succeeded and a binding that
 * failed would leave an orphan no member could manage.
 *
 * Seeded like every other project-creation site (`bootstrapOrganization`,
 * `ensureMemberDefaultProject`): an API key and a default agent, so the project
 * is usable the moment it exists rather than being an empty shell. Policy
 * seeding is best-effort for the same reason it is there — a seeding hiccup
 * must not fail the create.
 *
 * Authorization is HERE rather than in the route because there is no resource
 * to resolve yet. Any active member may create; a suspended member reads as no
 * role and is refused, the same suspension invariant every other gate applies.
 */
export const createProject = async (
  organizationId: string,
  userId: string,
  userEmail: string,
  name: string,
): Promise<ProjectRow> => {
  if (CAPS.rbac) {
    const resolver = getRoleResolver();
    const role = resolver
      ? await resolver.getUserRole(userId, organizationId)
      : null;
    if (!role) {
      throw new ServiceError(
        "FORBIDDEN",
        "You do not have permission to create a project.",
      );
    }
  }

  const count = await db.project.count({ where: { organizationId } });
  if (count >= MAX_PROJECTS_PER_ORG) {
    throw new ServiceError(
      "CONFLICT",
      `This organization has reached its limit of ${MAX_PROJECTS_PER_ORG} projects.`,
    );
  }

  const create = (slug: string) =>
    db.project.create({
      data: {
        id: generateProjectId(),
        name,
        slug,
        organizationId,
        createdByUserId: userId,
        createdByUserEmail: userEmail,
        ...defaultProjectSeed(userId, userEmail),
        accessBindings: { create: { userId, role: "owner" } },
      },
      select: projectSelect,
    });

  let row;
  try {
    row = await create(await freeSlug(organizationId, name));
  } catch (err) {
    // A concurrent create took the slug between our read and our write. Retry
    // once with a random tail; a second failure is a genuine error.
    if (!isUniqueViolation(err)) throw err;
    row = await create(
      `${slugify(name) || "project"}-${generateProjectId().slice(0, 8)}`,
    );
  }

  try {
    await getNewOrgPolicySeeder().seed(organizationId, row.id);
  } catch (err) {
    logger.warn(
      { err, organizationId, projectId: row.id },
      "created project policy seed failed",
    );
  }

  return toProjectRow(row);
};

/**
 * Rename. `name` ONLY — `slug` is immutable (it is write-only provenance,
 * never read by api/web/gateway, and it is `@@unique([organizationId, slug])`,
 * so rewriting it could collide). Names are NOT unique per org (see
 * `projectNameSchema`), so a rename-to-self and a rename onto a sibling's name
 * are both permitted 200s.
 */
export const renameProject = async (
  organizationId: string,
  projectId: string,
  name: string,
): Promise<ProjectRow> => {
  await requireProject(organizationId, projectId);

  // Org-scoped conditional write: count 0 means the row vanished (or never
  // belonged to this org) between the read and the write — 404, not a 500.
  const { count } = await db.project.updateMany({
    where: { id: projectId, organizationId },
    data: { name },
  });
  if (count === 0) throw new ServiceError("NOT_FOUND", "Project not found.");

  const row = await db.project.findFirst({
    where: { id: projectId, organizationId },
    select: projectSelect,
  });
  if (!row) throw new ServiceError("NOT_FOUND", "Project not found.");
  return toProjectRow(row);
};

/**
 * Delete a project, with an explicit pinned cascade.
 *
 * A bare `db.project.delete()` is NOT viable: `agents`, `vault_connections` and
 * `onboarding_surveys` are `ON DELETE RESTRICT` (and every project is born with
 * a default agent, so the P2003 would be universal), while `api_keys`,
 * `secrets`, `policy_rules`, `app_connections`, `app_configs` and `budgets` are
 * `ON DELETE SET NULL` — they would SURVIVE the project as orphaned
 * `scope: "project"` rows with `project_id = NULL`. Both hazards are handled by
 * deleting the children explicitly, in FK order, inside ONE transaction.
 *
 * Three refusals guard the lockout cases (a user with no resolvable project
 * gets a 401 on every request — a bricked dashboard, not a degraded one).
 * Refusing outright ("empty the project first") is not an option: the default
 * agent + API key mean a project can never be emptied through the product.
 */
export const deleteProject = async (
  organizationId: string,
  actorUserId: string,
  projectId: string,
): Promise<ProjectDeleteResult> => {
  const project = await requireProject(organizationId, projectId);

  // ── Guard 1: the org's last project ──────────────────────────────────────
  // Deleting it makes EVERY session in the org unresolvable — a total instance
  // lockout in OSS, where there is no project switcher to recover through.
  const projectCount = await db.project.count({ where: { organizationId } });
  if (projectCount <= 1) {
    throw new ServiceError(
      "CONFLICT",
      "An organization must keep at least one project.",
    );
  }

  // ── Guards 2 & 3: stranded users ─────────────────────────────────────────
  // Candidates are every human who could be relying on this project: direct
  // user bindings ∪ members of groups bound to it ∪ the creator. Restricted to
  // ACTIVE members of the org — a suspended or foreign user cannot be stranded
  // by definition (they resolve no project either way).
  const [userBindings, groupBindings] = await Promise.all([
    db.projectAccess.findMany({
      where: { projectId, userId: { not: null } },
      select: { userId: true },
    }),
    db.projectAccess.findMany({
      where: { projectId, groupId: { not: null } },
      select: { group: { select: { members: { select: { userId: true } } } } },
    }),
  ]);

  const candidates = new Set<string>();
  for (const row of userBindings) if (row.userId) candidates.add(row.userId);
  for (const row of groupBindings) {
    for (const m of row.group?.members ?? []) candidates.add(m.userId);
  }
  if (project.createdByUserId) candidates.add(project.createdByUserId);

  const activeMembers = await db.organizationMember.findMany({
    where: {
      organizationId,
      userId: { in: [...candidates] },
      // The shared "active member" filter, so a future change to what counts
      // as active lands here too instead of silently narrowing this guard.
      ...activeMembershipWhere,
    },
    select: { userId: true },
  });
  const atRisk = new Set(activeMembers.map((row) => row.userId));

  // Guard 3 (self) is checked FIRST so the actor's own case yields the sharper
  // message rather than being folded into the anonymous count below.
  if (
    atRisk.has(actorUserId) &&
    !(await hasResolvableProjectExcluding(actorUserId, projectId))
  ) {
    throw new ServiceError(
      "CONFLICT",
      "Deleting this project would leave you with no project.",
    );
  }

  // Guard 2: a serial loop, deliberately. The candidate set is bounded by the
  // access-PUT caps and this is a rare destructive action — per-user
  // correctness matters more than collapsing it into one clever query.
  let stranded = 0;
  for (const userId of atRisk) {
    if (userId === actorUserId) continue; // handled above
    if (!(await hasResolvableProjectExcluding(userId, projectId))) stranded++;
  }
  if (stranded > 0) {
    throw new ServiceError(
      "CONFLICT",
      `Deleting this project would leave ${stranded} member(s) with no project. Give them access to another project first.`,
    );
  }

  // Flush the gateway BEFORE the cascade, never after: `/v1/cache/invalidate`
  // authenticates the bearer through an UNCACHED `find_api_key` lookup
  // (apps/gateway/src/auth.rs), so a key deleted a moment ago cannot
  // authenticate its own flush — a post-delete call would silently 401 and
  // flush nothing. Flushing here is safe in both directions: if the
  // transaction below rolls back the gateway simply re-reads the config it
  // just dropped.
  const keyRows = await db.apiKey.findMany({
    where: { projectId },
    select: { key: true },
  });
  invalidateGatewayCacheForKeys(keyRows.map((row) => row.key));

  const [
    agents,
    apiKeys,
    secrets,
    policyRules,
    policyRulesV2,
    appConnections,
    appConfigs,
    vaultConnections,
    budgets,
    accessBindings,
    onboardingSurvey,
  ] = await Promise.all([
    db.agent.count({ where: { projectId } }),
    db.apiKey.count({ where: { projectId } }),
    db.secret.count({ where: { projectId } }),
    db.policyRule.count({ where: { projectId } }),
    db.policyRuleV2.count({ where: { projectId } }),
    db.appConnection.count({ where: { projectId } }),
    db.appConfig.count({ where: { projectId } }),
    db.vaultConnection.count({ where: { projectId } }),
    db.budget.count({ where: { projectId } }),
    db.projectAccess.count({ where: { projectId } }),
    db.onboardingSurvey.count({ where: { projectId } }),
  ]);

  // One transaction, children first, in FK order. Each line carries its FK
  // action so a future schema change is caught in review: a new RESTRICT child
  // without a line here is a P2003, a new SET NULL child is a silent orphan.
  //
  // Interactive (callback) form, not the array form, precisely so the final
  // `count === 0` check below can ROLL THE CASCADE BACK by throwing.
  await db.$transaction(async (tx) => {
    // RESTRICT — must precede the project. Cascades agent_secrets,
    // agent_app_connections, grant_rules, policy_rule_identities(agent).
    await tx.agent.deleteMany({ where: { projectId } });
    // SET NULL — explicit, else orphaned scope:"project" rows survive.
    // Cascades secret_access, budgets, policy_rule_targets(secret).
    await tx.secret.deleteMany({ where: { projectId } });
    // SET NULL — cascades connection_access, policy_rule_targets(connection).
    await tx.appConnection.deleteMany({ where: { projectId } });
    // SET NULL
    await tx.appConfig.deleteMany({ where: { projectId } });
    // SET NULL — an orphaned PROJECT api key must never outlive its project.
    await tx.apiKey.deleteMany({ where: { projectId } });
    // SET NULL (legacy rule model)
    await tx.policyRule.deleteMany({ where: { projectId } });
    // SET NULL (cloud-only budgets; inert in OSS)
    await tx.budget.deleteMany({ where: { projectId } });
    // RESTRICT
    await tx.vaultConnection.deleteMany({ where: { projectId } });
    // RESTRICT
    await tx.onboardingSurvey.deleteMany({ where: { projectId } });

    // Org-scoped conditional delete. Deliberately NOT deleted by hand:
    //  · policy_rules_v2 + project_access — DB CASCADE, removed with the row;
    //  · audit_logs — SET NULL by design: history SURVIVES and stays
    //    attributable through organization_id. Never delete audit rows.
    //  · request_logs — no FK at all: telemetry keeps a dangling project_id and
    //    becomes unreachable. Deleting it could be millions of rows in one
    //    transaction; out of scope here.
    const { count } = await tx.project.deleteMany({
      where: { id: projectId, organizationId },
    });
    // A 0 here means the project vanished (or was never ours) between the
    // resolve and the write — throwing rolls the whole cascade back.
    if (count === 0) throw new ServiceError("NOT_FOUND", "Project not found.");
  });

  return {
    id: project.id,
    name: project.name,
    removed: {
      agents,
      apiKeys,
      secrets,
      policyRules,
      policyRulesV2,
      appConnections,
      appConfigs,
      vaultConnections,
      budgets,
      accessBindings,
      onboardingSurvey,
    },
  };
};
