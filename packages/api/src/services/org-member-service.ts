import { db } from "@onecli/db";
import { ServiceError } from "./errors";
import {
  clampDirectoryLimit,
  decodeCursor,
  toDirectoryPage,
  type DirectoryPage,
} from "../lib/cursor";
import type {
  orgMemberRoleSchema,
  orgMemberStatusSchema,
} from "../validations/org";
import type { z } from "zod";

// The org's membership directory: the read side of the Team surface plus the
// two writes an admin can make (lifecycle + role). Scoped to ONE organization
// on every call — the caller's `auth.organizationId`, never a body/query
// parameter — so this can never read or write across orgs.

export type OrgMemberStatus = z.infer<typeof orgMemberStatusSchema>;
export type AssignableOrgRole = z.infer<typeof orgMemberRoleSchema>;

/** One row of the members directory (matches the client's `OrgMemberListRow`). */
export interface OrgMemberListRow {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  status: string;
  /** EE-only break-glass SSO exemption — always false in OSS. */
  ssoExempt: boolean;
  joinedAt: string;
}

export interface ListOrgMembersParams {
  limit?: number;
  cursor?: string;
  q?: string;
  status?: OrgMemberStatus;
}

/**
 * The list is ordered `createdAt asc, userId asc` and paged by that exact key:
 * `OrganizationMember` has a COMPOSITE primary key (no `id` column), and
 * `createdAt` alone is not unique, so the cursor must carry both halves or a
 * concurrent join could make a page skip or repeat rows.
 */
const CURSOR_PARTS = 2;

const cursorFilter = (raw: string | undefined) => {
  const parts = decodeCursor(raw, CURSOR_PARTS);
  if (!parts) return undefined;
  const [createdAtIso, userId] = parts;
  if (createdAtIso === undefined || userId === undefined) return undefined;
  const createdAt = new Date(createdAtIso);
  // A cursor whose timestamp half is not a date is malformed — serve page one
  // rather than handing an Invalid Date to the query layer.
  if (Number.isNaN(createdAt.getTime())) return undefined;
  return {
    OR: [
      { createdAt: { gt: createdAt } },
      { createdAt, userId: { gt: userId } },
    ],
  };
};

export const listOrgMembers = async (
  organizationId: string,
  params: ListOrgMembersParams = {},
): Promise<DirectoryPage<OrgMemberListRow>> => {
  const limit = clampDirectoryLimit(params.limit);
  const after = cursorFilter(params.cursor);
  const q = params.q?.trim();

  const rows = await db.organizationMember.findMany({
    where: {
      organizationId,
      ...(params.status ? { status: params.status } : {}),
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
      // The keyset predicate lives under AND, never as a top-level `OR` spread:
      // a future filter that also needs `OR` would otherwise overwrite the
      // cursor clause and silently restart pagination from the first page.
      ...(after ? { AND: [after] } : {}),
    },
    select: {
      userId: true,
      role: true,
      status: true,
      ssoExempt: true,
      createdAt: true,
      user: { select: { email: true, name: true } },
    },
    orderBy: [{ createdAt: "asc" }, { userId: "asc" }],
    take: limit + 1,
  });

  const members: OrgMemberListRow[] = rows.map((row) => ({
    userId: row.userId,
    email: row.user.email,
    name: row.user.name,
    role: row.role,
    status: row.status,
    ssoExempt: row.ssoExempt,
    joinedAt: row.createdAt.toISOString(),
  }));

  return toDirectoryPage(members, limit, (row) => [row.joinedAt, row.userId]);
};

const requireMember = async (organizationId: string, userId: string) => {
  const member = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { role: true, status: true },
  });
  if (!member) {
    throw new ServiceError(
      "NOT_FOUND",
      "That user is not a member of this organization.",
    );
  }
  return member;
};

const countActiveOwners = (organizationId: string) =>
  db.organizationMember.count({
    where: { organizationId, role: "owner", status: { not: "suspended" } },
  });

/**
 * Suspend or reinstate a member.
 *
 * Invariants, in order:
 * - the target must be a member of the acting org (404);
 * - nobody may change their OWN status (400) — an admin suspending themselves
 *   would lock themselves out of the surface that could undo it;
 * - owners are never SUSPENDABLE (403), and suspending the org's ONLY active
 *   owner reports the sharper conflict (409): an instance with no active owner
 *   has no recovery path.
 *
 * The owner guard covers the suspend direction ONLY. REINSTATING an owner must
 * stay possible: an org whose sole owner is somehow suspended (a hand-edited
 * row, an import, a future code path) is exactly the unrecoverable state these
 * rules exist to prevent, and refusing the repair would cement it.
 */
export const updateOrgMemberStatus = async (
  organizationId: string,
  actorUserId: string,
  targetUserId: string,
  status: OrgMemberStatus,
): Promise<{ userId: string; status: string; ssoExempt: boolean }> => {
  const member = await requireMember(organizationId, targetUserId);

  if (targetUserId === actorUserId) {
    throw new ServiceError("BAD_REQUEST", "You cannot suspend yourself.");
  }

  if (member.role === "owner" && status === "suspended") {
    if ((await countActiveOwners(organizationId)) <= 1)
      throw new ServiceError(
        "CONFLICT",
        "The organization must keep at least one active owner.",
      );
    throw new ServiceError(
      "FORBIDDEN",
      "Organization owners cannot be suspended.",
    );
  }

  return db.organizationMember.update({
    where: { organizationId_userId: { organizationId, userId: targetUserId } },
    data: {
      status,
      suspendedAt: status === "suspended" ? new Date() : null,
    },
    select: { userId: true, status: true, ssoExempt: true },
  });
};

/**
 * Change a member's org role.
 *
 * Only `admin` and `member` are assignable (the schema enforces it): owner
 * transfer is a separate, deliberately out-of-scope operation. Invariants:
 * target must be a member (404); nobody may change their own role (400 — an
 * admin cannot demote themselves out of the surface); owners are untouchable
 * here (403).
 */
export const updateOrgMemberRole = async (
  organizationId: string,
  actorUserId: string,
  targetUserId: string,
  role: AssignableOrgRole,
): Promise<{ userId: string; role: string }> => {
  const member = await requireMember(organizationId, targetUserId);

  if (targetUserId === actorUserId) {
    throw new ServiceError("BAD_REQUEST", "You cannot change your own role.");
  }

  if (member.role === "owner") {
    throw new ServiceError(
      "FORBIDDEN",
      "The organization owner's role cannot be changed.",
    );
  }

  return db.organizationMember.update({
    where: { organizationId_userId: { organizationId, userId: targetUserId } },
    data: { role },
    select: { userId: true, role: true },
  });
};
