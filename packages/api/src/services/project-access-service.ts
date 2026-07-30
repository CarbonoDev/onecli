import { db } from "@onecli/db";
import { ServiceError } from "./errors";
import { requireProject } from "./project-service";
import { hasResolvableProjectExcluding } from "./organization-service";
import {
  MAX_PROJECT_ACCESS_GROUPS,
  MAX_PROJECT_ACCESS_USERS,
  type SetProjectAccessInput,
} from "../validations/project";

// The project's human sharing surface: read the bindings, replace the set.
//
// `ProjectAccess` rows are LIVE authorization data read by three independent
// enforcement points — `middleware/auth/resolve.ts` (`hasProjectBinding`), the
// API-key auth path, and the Rust gateway's `load_principal_set`. None of them
// reads `role`: it is a MANAGEMENT discriminator only (13c), consulted solely
// by `canManageProject`. Every row is a use grant regardless of its role.
//
// Same three rules as `project-service.ts`: org-scoped `findFirst` (never
// `findUnique({ id })`), the org id always from `auth.organizationId`, and
// conditional writes.

/** One user binding, in the client's `ProjectAccessUserRow` shape. */
export interface ProjectAccessUserBinding {
  id: string;
  userId: string;
  name: string | null;
  email: string;
  role: "owner" | "member";
  isOwner: boolean;
  createdAt: string;
}

/** One group binding, in the client's `ProjectAccessGroupRow` shape. */
export interface ProjectAccessGroupBinding {
  id: string;
  groupId: string;
  name: string;
  memberCount: number;
  createdAt: string;
}

export interface ProjectAccessBindings {
  users: ProjectAccessUserBinding[];
  groups: ProjectAccessGroupBinding[];
}

/**
 * The delta a replace-set applied. Counts are AGGREGATED across users AND
 * groups — the dialog shows a single toast, so a split would be noise.
 */
export interface SetProjectAccessResult {
  added: number;
  removed: number;
  roleChanged: number;
}

/** `role` is a free-form DB column: normalize, NEVER cast (the ossRoleResolver
 * precedent). Anything that is not exactly "owner" is a plain use grant. */
const normalizeRole = (raw: string): "owner" | "member" =>
  raw === "owner" ? "owner" : "member";

/**
 * Read the project's bindings.
 *
 * User rows are filtered down to users who hold an `OrganizationMember` row in
 * this org (ANY status). A row for a non-member is inert anyway
 * (`canAccessProjectAsUser` demands an active membership) — and returning it
 * would make the UI's "open dialog, save without edits" round-trip 400 on
 * `setProjectAccess`'s org-membership assertion. SUSPENDED members ARE
 * returned: suspension is an auth-time gate, not a binding change.
 *
 * If this filter changes, `setProjectAccess`'s validation must change with it.
 */
export const listProjectAccess = async (
  organizationId: string,
  projectId: string,
): Promise<ProjectAccessBindings> => {
  const project = await requireProject(organizationId, projectId);

  const [userRows, groupRows] = await Promise.all([
    db.projectAccess.findMany({
      where: {
        projectId,
        userId: { not: null },
        user: { organizationMemberships: { some: { organizationId } } },
      },
      select: {
        id: true,
        userId: true,
        role: true,
        createdAt: true,
        user: { select: { email: true, name: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      // Bounded even against a hand-seeded database.
      take: MAX_PROJECT_ACCESS_USERS,
    }),
    db.projectAccess.findMany({
      where: {
        projectId,
        groupId: { not: null },
        // Org-fences the join exactly like the gateway's
        // `JOIN groups g ON … g.organization_id = $org`.
        group: { organizationId },
      },
      select: {
        id: true,
        groupId: true,
        createdAt: true,
        group: {
          select: { name: true, _count: { select: { members: true } } },
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: MAX_PROJECT_ACCESS_GROUPS,
    }),
  ]);

  return {
    users: userRows.flatMap((row) =>
      row.userId
        ? [
            {
              id: row.id,
              userId: row.userId,
              name: row.user?.name ?? null,
              email: row.user?.email ?? "",
              role: normalizeRole(row.role),
              // Provenance ONLY, deliberately independent of the (transferable)
              // management role: the creator keeps the badge after a demotion.
              isOwner: row.userId === project.createdByUserId,
              createdAt: row.createdAt.toISOString(),
            },
          ]
        : [],
    ),
    groups: groupRows.flatMap((row) =>
      row.groupId
        ? [
            {
              id: row.id,
              groupId: row.groupId,
              name: row.group?.name ?? "",
              memberCount: row.group?._count.members ?? 0,
              createdAt: row.createdAt.toISOString(),
            },
          ]
        : [],
    ),
  };
};

/**
 * THE security invariant of every binding write: `ProjectAccess.userId` FKs the
 * GLOBAL `User` table, so the organization scope exists ONLY in this check.
 * Every id must resolve to a member of the caller's org — one foreign id and
 * the whole write is rejected, or a project could capture users from another
 * organization. (A clone of `assertOrgMembers` in `org-group-service.ts`: the
 * org services keep their own copies by convention, which keeps this comment
 * next to the code it protects.)
 *
 * Suspended members are deliberately allowed: suspension is an AUTH-time gate,
 * and stripping bindings on suspend would silently rewrite the member's access
 * shape on reinstate.
 */
const assertOrgMembers = async (organizationId: string, userIds: string[]) => {
  if (userIds.length === 0) return;
  const rows = await db.organizationMember.findMany({
    where: { organizationId, userId: { in: userIds } },
    select: { userId: true },
  });
  const known = new Set(rows.map((row) => row.userId));
  if (userIds.some((id) => !known.has(id))) {
    throw new ServiceError(
      "BAD_REQUEST",
      "One or more users are not members of this organization.",
    );
  }
};

/** The same fence for group grantees. Unlike group MEMBERSHIP (IdP-owned, so
 * `requireManualGroup` applies), a project grant TO a group is OneCLI-owned
 * config: `source: "scim"` groups are valid grantees. */
const assertOrgGroups = async (organizationId: string, groupIds: string[]) => {
  if (groupIds.length === 0) return;
  const rows = await db.group.findMany({
    where: { organizationId, id: { in: groupIds } },
    select: { id: true },
  });
  const known = new Set(rows.map((row) => row.id));
  if (groupIds.some((id) => !known.has(id))) {
    throw new ServiceError(
      "BAD_REQUEST",
      "One or more groups do not belong to this organization.",
    );
  }
};

/**
 * Replace the project's binding set (users + groups) in one write.
 *
 * `actorIsOrgAdmin` is computed by the ROUTE from the role resolver (it already
 * resolved the role for `canManageProject`) and passed in: this service must
 * never re-resolve it, and must never accept it from the request body.
 */
export const setProjectAccess = async (
  organizationId: string,
  actorUserId: string,
  actorIsOrgAdmin: boolean,
  projectId: string,
  input: SetProjectAccessInput,
): Promise<SetProjectAccessResult> => {
  // Resolve FIRST, before any payload validation: a cross-org project id must
  // 404 without ever becoming an existence oracle for user/group ids.
  const project = await requireProject(organizationId, projectId);

  const users = input.users;
  // Groups carry no role, so a repeat is unambiguous — dedupe silently
  // (matching `setOrgGroupMembers`). Duplicate USERS are a 422 in the schema.
  const groupIds = [...new Set(input.groupIds)];

  await assertOrgMembers(
    organizationId,
    users.map((u) => u.userId),
  );
  await assertOrgGroups(organizationId, groupIds);

  // ── Guard G: the set must keep an owner ──────────────────────────────────
  // Covers three failure modes at once: demoting every owner, clearing all
  // users, and the legacy zero-binding project (the admin is forced to name an
  // owner rather than saving an empty set over an already-orphaned project).
  if (!users.some((u) => u.role === "owner")) {
    throw new ServiceError(
      "BAD_REQUEST",
      "A project must keep at least one owner.",
    );
  }

  const currentRows = await db.projectAccess.findMany({
    where: { projectId },
    select: { id: true, userId: true, groupId: true, role: true },
  });

  const currentUsers = new Map<string, string>();
  const currentGroups = new Set<string>();
  for (const row of currentRows) {
    if (row.userId) currentUsers.set(row.userId, normalizeRole(row.role));
    else if (row.groupId) currentGroups.add(row.groupId);
  }

  // ── Guard H: the actor may not strand themselves ─────────────────────────
  // A NON-ADMIN may neither drop nor demote themselves: the binding IS their
  // authority here. (Mirrors `updateOrgMemberStatus`'s "You cannot suspend
  // yourself.")
  //
  // An org admin keeps the DEMOTION exemption — their authority comes from the
  // org role, so an ownership hand-off must stay possible — but NOT a free
  // self-REMOVAL. `findUserDefaultProject` has exactly two arms (created the
  // project, or holds a binding), so an admin whose only path to any project
  // was this binding resolves NO project once it is gone: `authenticateSession`
  // then falls back to an `X-Organization-Id` header OSS web never sends and
  // 401s every request — including the PUT they would need to re-grant. That is
  // the same lockout `deleteProject` spends three guards preventing, so it is
  // checked with the same oracle. Excluding THIS project is correct: the
  // binding on it is exactly what is going away, while the created-by arm
  // survives the write and is checked separately.
  //
  // Deliberately conservative: a group binding on THIS project that would keep
  // the admin resolving is not counted, so the worst case is a refusal to
  // perform a safe removal — never a lockout.
  if (currentUsers.has(actorUserId)) {
    const mine = users.find((u) => u.userId === actorUserId);
    if (!mine) {
      if (!actorIsOrgAdmin) {
        throw new ServiceError(
          "BAD_REQUEST",
          "You cannot remove your own access to this project.",
        );
      }
      const staysResolvable =
        project.createdByUserId === actorUserId ||
        (await hasResolvableProjectExcluding(actorUserId, projectId));
      if (!staysResolvable) {
        throw new ServiceError(
          "BAD_REQUEST",
          "Removing your own access would leave you with no project.",
        );
      }
    } else if (
      !actorIsOrgAdmin &&
      mine.role !== "owner" &&
      currentUsers.get(actorUserId) === "owner"
    ) {
      throw new ServiceError(
        "BAD_REQUEST",
        "You cannot remove your own management access to this project.",
      );
    }
  }

  const targetUsers = new Map(users.map((u) => [u.userId, u.role]));
  const targetGroups = new Set(groupIds);

  const userAdds = users.filter((u) => !currentUsers.has(u.userId));
  const userRemoves = [...currentUsers.keys()].filter(
    (id) => !targetUsers.has(id),
  );
  const roleChanges = [...targetUsers.entries()].filter(
    ([id, role]) => currentUsers.has(id) && currentUsers.get(id) !== role,
  );
  const groupAdds = groupIds.filter((id) => !currentGroups.has(id));
  const groupRemoves = [...currentGroups].filter((id) => !targetGroups.has(id));

  // Early no-op: nothing to write, so no transaction is opened
  // (`setOrgGroupMembers` precedent). The route's audit + gateway flush still
  // run — cheap, and simpler than making withAudit conditional.
  if (
    userAdds.length === 0 &&
    userRemoves.length === 0 &&
    roleChanges.length === 0 &&
    groupAdds.length === 0 &&
    groupRemoves.length === 0
  ) {
    return { added: 0, removed: 0, roleChanged: 0 };
  }

  const toOwner = roleChanges
    .filter(([, role]) => role === "owner")
    .map(([id]) => id);
  const toMember = roleChanges
    .filter(([, role]) => role === "member")
    .map(([id]) => id);

  await db.$transaction([
    // Deletes BEFORE creates: `@@unique([projectId, userId])` and
    // `@@unique([projectId, groupId])` are partial (Postgres treats NULLs as
    // distinct), so a create racing a delete on the same key would P2002.
    db.projectAccess.deleteMany({
      where: { projectId, userId: { in: userRemoves } },
    }),
    db.projectAccess.deleteMany({
      where: { projectId, groupId: { in: groupRemoves } },
    }),
    db.projectAccess.updateMany({
      where: { projectId, userId: { in: toOwner } },
      data: { role: "owner" },
    }),
    db.projectAccess.updateMany({
      where: { projectId, userId: { in: toMember } },
      data: { role: "member" },
    }),
    // The DB CHECK is `num_nonnulls(user_id, group_id) = 1`. Each row below is
    // built literally, with EXACTLY ONE principal column — never from a shared
    // spread object that could carry both. `skipDuplicates` makes a concurrent
    // double-add idempotent instead of a P2002.
    db.projectAccess.createMany({
      data: userAdds.map((u) => ({
        projectId,
        userId: u.userId,
        role: u.role,
        createdByUserId: actorUserId,
      })),
      skipDuplicates: true,
    }),
    db.projectAccess.createMany({
      // Group bindings are ALWAYS "member": the client payload has no group
      // role and the gateway ignores `role` entirely — this must never gain a
      // silent management path.
      data: groupAdds.map((groupId) => ({
        projectId,
        groupId,
        role: "member",
        createdByUserId: actorUserId,
      })),
      skipDuplicates: true,
    }),
  ]);

  return {
    added: userAdds.length + groupAdds.length,
    removed: userRemoves.length + groupRemoves.length,
    roleChanged: roleChanges.length,
  };
};
