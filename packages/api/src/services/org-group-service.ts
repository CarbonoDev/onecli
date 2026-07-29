import { db, Prisma } from "@onecli/db";
import { ServiceError } from "./errors";
import {
  clampDirectoryLimit,
  decodeCursor,
  toDirectoryPage,
  type DirectoryPage,
} from "../lib/cursor";
import type { GroupListQuery } from "../validations/org";

// The org's human-group directory: list/create/rename/delete plus the three
// membership writers. Scoped to ONE organization on every call — the caller's
// `auth.organizationId`, never a body/query parameter — so this can never
// read or write across orgs.
//
// `source` is read-only: creates hard-code "manual", and "scim" rows
// (IdP-provisioned in EE) reject every mutation with 409 — the dashboard must
// never fight the IdP over a provisioned group.

/** One row of the groups directory (matches the client's `GroupRow`). */
export interface GroupListRow {
  id: string;
  name: string;
  source: string;
  externalId: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

/** One row of a group's member list (matches the client's `GroupMemberRow`). */
export interface GroupMemberListRow {
  userId: string;
  email: string;
  name: string | null;
  addedAt: string;
}

/** What a delete actually removed — the cascade impact, read BEFORE the delete. */
export interface GroupDeleteResult {
  id: string;
  name: string;
  removedMembers: number;
  removedProjectBindings: number;
}

export type ListOrgGroupsParams = Partial<GroupListQuery>;

/**
 * Same keyset shape as the invitations directory: ordered `createdAt asc,
 * id asc` and paged by that exact two-part key, since `createdAt` alone is
 * not unique.
 */
const CURSOR_PARTS = 2;

const cursorFilter = (raw: string | undefined) => {
  const parts = decodeCursor(raw, CURSOR_PARTS);
  if (!parts) return undefined;
  const [createdAtIso, id] = parts;
  if (createdAtIso === undefined || id === undefined) return undefined;
  const createdAt = new Date(createdAtIso);
  // A cursor whose timestamp half is not a date is malformed — serve page one
  // rather than handing an Invalid Date to the query layer.
  if (Number.isNaN(createdAt.getTime())) return undefined;
  return {
    OR: [{ createdAt: { gt: createdAt } }, { createdAt, id: { gt: id } }],
  };
};

/** Member pages are keyed `createdAt asc, userId asc` (composite PK, no id). */
const memberCursorFilter = (raw: string | undefined) => {
  const parts = decodeCursor(raw, CURSOR_PARTS);
  if (!parts) return undefined;
  const [createdAtIso, userId] = parts;
  if (createdAtIso === undefined || userId === undefined) return undefined;
  const createdAt = new Date(createdAtIso);
  if (Number.isNaN(createdAt.getTime())) return undefined;
  return {
    OR: [
      { createdAt: { gt: createdAt } },
      { createdAt, userId: { gt: userId } },
    ],
  };
};

export const listOrgGroups = async (
  organizationId: string,
  params: ListOrgGroupsParams = {},
): Promise<DirectoryPage<GroupListRow>> => {
  const limit = clampDirectoryLimit(params.limit);
  const after = cursorFilter(params.cursor);
  const q = params.q?.trim();

  const rows = await db.group.findMany({
    where: {
      organizationId,
      ...(params.source ? { source: params.source } : {}),
      ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}),
      // The keyset predicate lives under AND, never as a top-level `OR` spread:
      // a future filter that also needs `OR` would otherwise overwrite the
      // cursor clause and silently restart pagination from the first page.
      ...(after ? { AND: [after] } : {}),
    },
    select: {
      id: true,
      name: true,
      source: true,
      externalId: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { members: true } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit + 1,
  });

  const groups: GroupListRow[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    source: row.source,
    externalId: row.externalId,
    memberCount: row._count.members,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));

  return toDirectoryPage(groups, limit, (row) => [row.createdAt, row.id]);
};

/**
 * Resolve a group WITHIN the caller's org — always
 * `findFirst({ id, organizationId })`, NEVER `findUnique({ where: { id } })`:
 * a cross-org id must read as absent (404), not leak another org's row.
 */
const requireGroup = async (organizationId: string, groupId: string) => {
  const group = await db.group.findFirst({
    where: { id: groupId, organizationId },
    select: { id: true, name: true, source: true },
  });
  if (!group) throw new ServiceError("NOT_FOUND", "Group not found.");
  return group;
};

/** Mutations additionally require manual provenance ("scim" rows are IdP-owned). */
const requireManualGroup = async (organizationId: string, groupId: string) => {
  const group = await requireGroup(organizationId, groupId);
  if (group.source !== "manual") {
    throw new ServiceError(
      "CONFLICT",
      "This group is managed by your identity provider and cannot be changed here.",
    );
  }
  return group;
};

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

export const createOrgGroup = async (
  organizationId: string,
  name: string,
): Promise<GroupListRow> => {
  // Friendly pre-check for the common case; the P2002 catch below covers the
  // create-create race the pre-check cannot see.
  const dupe = await db.group.findFirst({
    where: { organizationId, name },
    select: { id: true },
  });
  if (dupe) {
    throw new ServiceError(
      "CONFLICT",
      "A group with this name already exists.",
    );
  }

  try {
    const row = await db.group.create({
      // `source` is hard-coded: a create can never mint a "scim" row.
      data: { organizationId, name, source: "manual" },
      select: {
        id: true,
        name: true,
        source: true,
        externalId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return {
      id: row.id,
      name: row.name,
      source: row.source,
      externalId: row.externalId,
      memberCount: 0,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ServiceError(
        "CONFLICT",
        "A group with this name already exists.",
      );
    }
    throw err;
  }
};

export const renameOrgGroup = async (
  organizationId: string,
  groupId: string,
  name: string,
): Promise<GroupListRow> => {
  const group = await requireManualGroup(organizationId, groupId);

  // Rename-to-self is a permitted no-op (a 409 here would make the rename
  // dialog's "Save without edits" an error).
  if (group.name !== name) {
    const dupe = await db.group.findFirst({
      where: { organizationId, name, id: { not: groupId } },
      select: { id: true },
    });
    if (dupe) {
      throw new ServiceError(
        "CONFLICT",
        "A group with this name already exists.",
      );
    }
  }

  // Org-scoped conditional write (the delete path's deleteMany pattern) — a
  // count of 0 means the row vanished between the check and the write, which
  // is a 404, not the P2025 500 a bare update() would surface.
  try {
    const { count } = await db.group.updateMany({
      where: { id: groupId, organizationId },
      data: { name },
    });
    if (count === 0) throw new ServiceError("NOT_FOUND", "Group not found.");
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ServiceError(
        "CONFLICT",
        "A group with this name already exists.",
      );
    }
    throw err;
  }

  const row = await db.group.findFirst({
    where: { id: groupId, organizationId },
    select: {
      id: true,
      name: true,
      source: true,
      externalId: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { members: true } },
    },
  });
  if (!row) throw new ServiceError("NOT_FOUND", "Group not found.");
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    externalId: row.externalId,
    memberCount: row._count.members,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
};

/**
 * Delete a group. The DB cascades take everything down with the row —
 * GroupMember, the group's ProjectAccess bindings, its GroupRoleMapping, and
 * PolicyRuleIdentity.group rows — so the impact is read FIRST and returned:
 * the project-access cascade is a SILENT access revocation, and the confirm
 * dialog must be able to say what went with the group.
 *
 * NOTE (reconciliation Stage C): the OSS grants engine treats a rule identity
 * orphaned by an FK cascade as INERT — it is skipped at compile time, never
 * widened to "any principal" (see grants-service). So a group delete needs no
 * explicit orphan-neutralization pass here; the identity rows simply cascade
 * away and the rules that referenced them lose one target. Role automation
 * (group→org-role mappings) is likewise not a live OSS concept, so there is no
 * mapping re-resolution to run. Both integrations belong to later stages.
 */
export const deleteOrgGroup = async (
  organizationId: string,
  groupId: string,
): Promise<GroupDeleteResult> => {
  const group = await db.group.findFirst({
    where: { id: groupId, organizationId },
    select: {
      id: true,
      name: true,
      source: true,
      _count: { select: { members: true, projectAccess: true } },
    },
  });
  if (!group) throw new ServiceError("NOT_FOUND", "Group not found.");
  if (group.source !== "manual") {
    throw new ServiceError(
      "CONFLICT",
      "This group is managed by your identity provider and cannot be changed here.",
    );
  }

  // Org-scoped conditional delete: a count of 0 means the row vanished (or
  // never belonged to this org) between the read and the write — 404 either
  // way, never a cross-org delete. The DB cascades (GroupMember, ProjectAccess,
  // GroupRoleMapping, PolicyRuleIdentity) run with the row.
  const { count } = await db.group.deleteMany({
    where: { id: groupId, organizationId },
  });
  if (count === 0) throw new ServiceError("NOT_FOUND", "Group not found.");

  return {
    id: group.id,
    name: group.name,
    removedMembers: group._count.members,
    removedProjectBindings: group._count.projectAccess,
  };
};

export interface ListOrgGroupMembersParams {
  limit?: number;
  cursor?: string;
  q?: string;
}

export const listOrgGroupMembers = async (
  organizationId: string,
  groupId: string,
  params: ListOrgGroupMembersParams = {},
): Promise<DirectoryPage<GroupMemberListRow>> => {
  await requireGroup(organizationId, groupId);
  const limit = clampDirectoryLimit(params.limit);
  const after = memberCursorFilter(params.cursor);
  const q = params.q?.trim();

  const rows = await db.groupMember.findMany({
    where: {
      groupId,
      ...(q
        ? {
            user: {
              OR: [
                { email: { contains: q, mode: "insensitive" as const } },
                { name: { contains: q, mode: "insensitive" as const } },
              ],
            },
          }
        : {}),
      // Keyset predicate under AND — see listOrgGroups.
      ...(after ? { AND: [after] } : {}),
    },
    select: {
      userId: true,
      createdAt: true,
      user: { select: { email: true, name: true } },
    },
    orderBy: [{ createdAt: "asc" }, { userId: "asc" }],
    take: limit + 1,
  });

  const members: GroupMemberListRow[] = rows.map((row) => ({
    userId: row.userId,
    email: row.user.email,
    name: row.user.name,
    addedAt: row.createdAt.toISOString(),
  }));

  return toDirectoryPage(members, limit, (row) => [row.addedAt, row.userId]);
};

/**
 * THE security invariant of every membership write: `GroupMember.userId` FKs
 * the GLOBAL `User` table, so the org scope exists ONLY in this check. Every
 * id must resolve to a member of the caller's org — one foreign id in the set
 * and the whole write is rejected, or a group could capture users from
 * another organization.
 *
 * Suspended members are deliberately allowed: suspension is an AUTH-time
 * gate, and stripping group rows on suspend would silently rewrite the
 * member's access shape on reinstate.
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

/**
 * Replace the group's member set. Returns the honest delta; a no-delta call
 * returns `{ added: 0, removed: 0 }` WITHOUT opening a transaction (and the
 * route's audit/flush still runs — cheap, and simpler than making withAudit
 * conditional).
 */
export const setOrgGroupMembers = async (
  organizationId: string,
  actorUserId: string,
  groupId: string,
  userIds: string[],
): Promise<{ added: number; removed: number }> => {
  await requireManualGroup(organizationId, groupId);

  const targetIds = [...new Set(userIds)];
  await assertOrgMembers(organizationId, targetIds);

  const target = new Set(targetIds);
  const currentRows = await db.groupMember.findMany({
    where: { groupId },
    select: { userId: true },
  });
  const current = new Set(currentRows.map((row) => row.userId));

  const toAdd = [...target].filter((id) => !current.has(id));
  const toRemove = [...current].filter((id) => !target.has(id));

  if (toAdd.length === 0 && toRemove.length === 0) {
    return { added: 0, removed: 0 };
  }

  await db.$transaction([
    db.groupMember.deleteMany({
      where: { groupId, userId: { in: toRemove } },
    }),
    // skipDuplicates makes a concurrent double-add idempotent (composite PK)
    // instead of surfacing a P2002.
    db.groupMember.createMany({
      data: toAdd.map((userId) => ({
        groupId,
        userId,
        createdByUserId: actorUserId,
      })),
      skipDuplicates: true,
    }),
  ]);

  return { added: toAdd.length, removed: toRemove.length };
};

/**
 * Idempotent single add (the scripting surface). `added` is honest: false
 * when the membership already existed.
 */
export const addOrgGroupMember = async (
  organizationId: string,
  actorUserId: string,
  groupId: string,
  userId: string,
): Promise<{ added: boolean }> => {
  await requireManualGroup(organizationId, groupId);
  await assertOrgMembers(organizationId, [userId]);

  const existing = await db.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
    select: { userId: true },
  });

  await db.groupMember.upsert({
    where: { groupId_userId: { groupId, userId } },
    create: { groupId, userId, createdByUserId: actorUserId },
    update: {},
  });

  return { added: !existing };
};

/**
 * Idempotent single remove: a missing membership is NOT a 404 (`removed:
 * false`) — only a missing/cross-org GROUP is.
 */
export const removeOrgGroupMember = async (
  organizationId: string,
  groupId: string,
  userId: string,
): Promise<{ removed: boolean }> => {
  await requireManualGroup(organizationId, groupId);

  const { count } = await db.groupMember.deleteMany({
    where: { groupId, userId },
  });

  return { removed: count > 0 };
};
