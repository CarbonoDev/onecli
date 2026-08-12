import { randomBytes } from "crypto";
import { db } from "@onecli/db";
import { ServiceError } from "./errors";
import {
  clampDirectoryLimit,
  decodeCursor,
  toDirectoryPage,
  type DirectoryPage,
} from "../lib/cursor";
import { attachMemberToProject } from "./organization-service";
import { IDENTITY_CONFLICT_ERROR } from "../routes/auth-session";
import type { CreateInvitationInput } from "../validations/org";
import type { z } from "zod";
import type { invitationStatusSchema } from "../validations/org";

// Link-based org invitations: the admin write side (create / revoke / list)
// plus the invitee-facing reads and the accept path. Scoped to ONE
// organization on every admin call — the caller's `auth.organizationId`,
// never a body/query parameter — so this can never read or write across
// orgs. The token-keyed entry points (`describeInvitation`,
// `acceptInvitation`) derive their org from the token's own row.
//
// The token is a bearer secret: it must NEVER appear in audit metadata, log
// lines, or error messages. The only channels that carry it are the create
// response and the admin list (both admin-only, D-D).

export type InvitationStatus = z.infer<typeof invitationStatusSchema>;

const INVITATION_TTL_DAYS = 7;
const MAX_PENDING_INVITATIONS = 100;

/** House-style secret token (matches `generateApiKey`): prefix + 32 random bytes. */
export const generateInvitationToken = () =>
  `inv_${randomBytes(32).toString("hex")}`;

const invitationExpiry = () =>
  new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);

/** One row of the invitations directory (matches the client's `InvitationRow`). */
export interface InvitationListRow {
  id: string;
  email: string;
  role: string;
  /** PROJECTED: a stored "pending" past its expiresAt reads "expired". */
  status: string;
  invitedByEmail: string;
  expiresAt: string;
  createdAt: string;
  /** Raw link token — admin-only channel (the UI composes /join/<token>). */
  token: string;
}

export interface ListOrgInvitationsParams {
  limit?: number;
  cursor?: string;
  q?: string;
  status?: InvitationStatus;
}

/**
 * Same keyset shape as the members directory: ordered `createdAt asc, id asc`
 * and paged by that exact two-part key, since `createdAt` alone is not unique.
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

const isExpired = (expiresAt: Date, now = new Date()) =>
  expiresAt.getTime() <= now.getTime();

/**
 * Display-only expiry projection: a stored "pending" past its `expiresAt`
 * reads "expired" WITHOUT a write (there is no sweeper in OSS; the lazy
 * write-back happens only on an accept attempt).
 */
const projectStatus = (status: string, expiresAt: Date, now: Date) =>
  status === "pending" && isExpired(expiresAt, now) ? "expired" : status;

export const listOrgInvitations = async (
  organizationId: string,
  params: ListOrgInvitationsParams = {},
): Promise<DirectoryPage<InvitationListRow>> => {
  const limit = clampDirectoryLimit(params.limit);
  const after = cursorFilter(params.cursor);
  const q = params.q?.trim();
  const now = new Date();

  const rows = await db.invitation.findMany({
    where: {
      organizationId,
      // The filter applies to the STORED status: the expiry projection below
      // is display-only, so `status=pending` can return rows that render as
      // "expired". Deliberate — "fixing" the mismatch here would make the
      // filter disagree with the database and with the accept path.
      ...(params.status ? { status: params.status } : {}),
      ...(q ? { email: { contains: q, mode: "insensitive" as const } } : {}),
      // The keyset predicate lives under AND, never as a top-level `OR` spread:
      // a future filter that also needs `OR` would otherwise overwrite the
      // cursor clause and silently restart pagination from the first page.
      ...(after ? { AND: [after] } : {}),
    },
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      invitedByEmail: true,
      expiresAt: true,
      createdAt: true,
      token: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit + 1,
  });

  const invitations: InvitationListRow[] = rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    status: projectStatus(row.status, row.expiresAt, now),
    invitedByEmail: row.invitedByEmail,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    token: row.token,
  }));

  return toDirectoryPage(invitations, limit, (row) => [row.createdAt, row.id]);
};

/**
 * Create (or re-issue) an invitation for an email address.
 *
 * Ordered guards:
 * 1. self-invite (400);
 * 2. the address already belongs to a member of this org — active (409) and
 *    suspended (409, distinct message: the fix is reinstating, not inviting);
 * 3. a pending, unexpired invitation already exists (409 — copy its link or
 *    revoke it first); any other stored status, or an expired pending row,
 *    falls through and is OVERWRITTEN;
 * 4. the pending cap (409).
 *
 * The write is an upsert because `@@unique([organizationId, email])` means a
 * plain create would 500 on any re-invite; the update arm re-mints the token
 * and resets the row to a fresh pending state.
 */
export const createOrgInvitation = async (
  organizationId: string,
  invitedById: string,
  invitedByEmail: string,
  input: CreateInvitationInput,
): Promise<InvitationListRow> => {
  const email = input.email; // already trimmed + lowercased by the schema
  const now = new Date();

  if (email === invitedByEmail.trim().toLowerCase()) {
    throw new ServiceError(
      "BAD_REQUEST",
      "You are already in this organization.",
    );
  }

  const existingUser = await db.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (existingUser) {
    const membership = await db.organizationMember.findUnique({
      where: {
        organizationId_userId: { organizationId, userId: existingUser.id },
      },
      select: { status: true },
    });
    if (membership) {
      if (membership.status === "suspended") {
        throw new ServiceError(
          "CONFLICT",
          "That address belongs to a suspended member — reinstate them from the members list instead.",
        );
      }
      throw new ServiceError(
        "CONFLICT",
        "That address is already a member of this organization.",
      );
    }
  }

  const existing = await db.invitation.findUnique({
    where: { organizationId_email: { organizationId, email } },
    select: { status: true, expiresAt: true },
  });
  if (
    existing &&
    existing.status === "pending" &&
    !isExpired(existing.expiresAt, now)
  ) {
    throw new ServiceError(
      "CONFLICT",
      "An invitation is already pending for this address — copy its link or revoke it first.",
    );
  }

  const pendingCount = await db.invitation.count({
    where: { organizationId, status: "pending" },
  });
  if (pendingCount >= MAX_PENDING_INVITATIONS) {
    throw new ServiceError(
      "CONFLICT",
      `This organization already has ${MAX_PENDING_INVITATIONS} pending invitations — revoke unused ones first.`,
    );
  }

  // Fence the chosen project to THIS organization. Resolve-then-reject, so a
  // cross-org id reads as absent rather than confirming it exists.
  if (input.projectId) {
    const inOrg = await db.project.findFirst({
      where: { id: input.projectId, organizationId },
      select: { id: true },
    });
    if (!inOrg) {
      throw new ServiceError(
        "BAD_REQUEST",
        "That project does not belong to this organization.",
      );
    }
  }

  const fresh = {
    token: generateInvitationToken(),
    status: "pending",
    role: input.role,
    projectId: input.projectId ?? null,
    invitedById,
    invitedByEmail,
    expiresAt: invitationExpiry(),
  };

  const row = await db.invitation.upsert({
    where: { organizationId_email: { organizationId, email } },
    create: { organizationId, email, ...fresh },
    update: fresh,
  });

  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    invitedByEmail: row.invitedByEmail,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    token: row.token,
  };
};

/**
 * Revoke a pending invitation: status → "cancelled" (the schema's value),
 * never a hard delete — the row keeps its audit trail and its unique slot.
 *
 * The conditional update is scoped `{ id, organizationId, status: "pending" }`;
 * on a miss the re-read is scoped `{ id, organizationId }` too (NEVER a bare
 * `findUnique({ where: { id } })`) so a cross-org id reads as absent (404)
 * rather than leaking another org's row into the 409 arm.
 */
export const revokeOrgInvitation = async (
  organizationId: string,
  invitationId: string,
): Promise<{ id: string; email: string }> => {
  const { count } = await db.invitation.updateMany({
    where: { id: invitationId, organizationId, status: "pending" },
    data: { status: "cancelled" },
  });

  const row = await db.invitation.findFirst({
    where: { id: invitationId, organizationId },
    select: { id: true, email: true },
  });

  if (!row) throw new ServiceError("NOT_FOUND", "Invitation not found.");
  if (count === 0) {
    throw new ServiceError(
      "CONFLICT",
      "Only pending invitations can be revoked.",
    );
  }
  return row;
};

/** The join page's viewer: the auth session, which may have no DB user row yet. */
export interface InvitationViewer {
  /** The EXTERNAL auth id (`session.id`), never a DB `User.id`. */
  externalAuthId: string;
  email: string;
}

/**
 * Discriminated union for the join page — a pure switch over `state`, so the
 * page never branches on strings or recomputes policy (D-L). `not-found`
 * carries NOTHING but the state: an unknown token must stay generic.
 */
export type InvitationView =
  | { state: "not-found" }
  | { state: "revoked" | "expired" | "accepted"; organizationName: string }
  | { state: "already-member"; organizationName: string }
  | { state: "suspended"; organizationName: string }
  | {
      state: "signin-required" | "ready" | "other-org";
      organizationName: string;
      invitedEmail: string;
      role: string;
      invitedByEmail: string;
      expiresAt: string;
    }
  | {
      state: "wrong-email";
      organizationName: string;
      invitedEmail: string;
      viewerEmail: string;
    };

const normalizeEmail = (email: string) => email.trim().toLowerCase();

/**
 * Read-only description of an invitation for its landing page. Never writes:
 * the expiry projection is display-only, and the viewer's DB user row is only
 * LOOKED UP (a GET render must never create state).
 */
export const describeInvitation = async (
  token: string,
  viewer: InvitationViewer | null,
): Promise<InvitationView> => {
  const invitation = await db.invitation.findUnique({
    where: { token },
    include: { organization: { select: { name: true } } },
  });
  if (!invitation) return { state: "not-found" };

  const organizationName = invitation.organization.name;

  // A signed-in viewer who is already on the org's roster gets the
  // membership answer FIRST — it outranks every invitation-status state
  // (their own accepted invitation should read "you're already in").
  if (viewer) {
    const dbUser = await db.user.findUnique({
      where: { externalAuthId: viewer.externalAuthId },
      select: { id: true },
    });
    if (dbUser) {
      const membership = await db.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId: invitation.organizationId,
            userId: dbUser.id,
          },
        },
        select: { status: true },
      });
      if (membership) {
        return membership.status === "suspended"
          ? { state: "suspended", organizationName }
          : { state: "already-member", organizationName };
      }
    }

    if (invitation.status === "cancelled")
      return { state: "revoked", organizationName };
    if (invitation.status === "accepted")
      return { state: "accepted", organizationName };
    if (invitation.status === "expired" || isExpired(invitation.expiresAt))
      return { state: "expired", organizationName };

    if (normalizeEmail(viewer.email) !== invitation.email) {
      return {
        state: "wrong-email",
        organizationName,
        invitedEmail: invitation.email,
        viewerEmail: viewer.email,
      };
    }

    const summary = {
      organizationName,
      invitedEmail: invitation.email,
      role: invitation.role,
      invitedByEmail: invitation.invitedByEmail,
      expiresAt: invitation.expiresAt.toISOString(),
    };

    // D-A: an already-bootstrapped user keeps landing in their own org after
    // joining (`findUserDefaultProject` arm 1) — accept still works, but the
    // page warns before the Join click.
    if (dbUser) {
      const otherMembership = await db.organizationMember.findFirst({
        where: {
          userId: dbUser.id,
          organizationId: { not: invitation.organizationId },
        },
        select: { organizationId: true },
      });
      if (otherMembership) return { state: "other-org", ...summary };
    }

    return { state: "ready", ...summary };
  }

  if (invitation.status === "cancelled")
    return { state: "revoked", organizationName };
  if (invitation.status === "accepted")
    return { state: "accepted", organizationName };
  if (invitation.status === "expired" || isExpired(invitation.expiresAt))
    return { state: "expired", organizationName };

  return {
    state: "signin-required",
    organizationName,
    invitedEmail: invitation.email,
    role: invitation.role,
    invitedByEmail: invitation.invitedByEmail,
    expiresAt: invitation.expiresAt.toISOString(),
  };
};

export interface AcceptResult {
  organizationId: string;
  organizationName: string;
  projectId: string;
  role: string;
  alreadyMember: boolean;
  invitationId: string;
}

/**
 * Accept an invitation by token. Ordered invariants:
 * 1. unknown token → 404 (generic — no oracle for token guessing);
 * 2. non-pending → 410;
 * 3. past expiry → best-effort write-back to "expired", then 410;
 * 4. session email must match the invited address (D-C) → 403. A failed
 *    attempt must NOT burn the token, which is why this check precedes the
 *    single-use claim;
 * 5. already a member: active → idempotent success (mark accepted,
 *    find-or-create the default project); suspended → 409 (an invite link
 *    must never bypass a suspension — reinstate from /team);
 * 6. SINGLE-USE CLAIM: a conditional pending→accepted update that must win
 *    (`count === 1`) BEFORE the membership is created. Deliberately not a
 *    $transaction (zero usage in this package); the known trade-off is that a
 *    post-claim failure burns the invitation and the admin re-invites.
 * 7. membership upsert (idempotent against a concurrent join);
 * 8. `attachMemberToProject` is awaited and NOT best-effort: without a project
 *    the session redirect dead-ends on /create-org, which does not exist in
 *    OSS. It ATTACHES to an existing project (the one the inviter chose, else
 *    the org's oldest) rather than minting a personal one.
 */
export const acceptInvitation = async (
  token: string,
  userId: string,
  userEmail: string,
): Promise<AcceptResult> => {
  const invitation = await db.invitation.findUnique({
    where: { token },
    include: { organization: { select: { name: true } } },
  });
  if (!invitation) {
    throw new ServiceError("NOT_FOUND", "Invitation not found.");
  }

  const { organizationId } = invitation;
  const organizationName = invitation.organization.name;

  if (invitation.status !== "pending") {
    throw new ServiceError("GONE", "This invitation is no longer active.");
  }

  if (isExpired(invitation.expiresAt)) {
    // Lazy write-back: best-effort, conditional so a concurrent accept/revoke
    // is never overwritten.
    await db.invitation.updateMany({
      where: { id: invitation.id, status: "pending" },
      data: { status: "expired" },
    });
    throw new ServiceError("GONE", "This invitation has expired.");
  }

  if (normalizeEmail(userEmail) !== invitation.email) {
    throw new ServiceError(
      "FORBIDDEN",
      `This invitation was issued to ${invitation.email}, but you are signed in as ${userEmail}. Sign in with the invited address to join.`,
    );
  }

  const existingMembership = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { role: true, status: true },
  });

  if (existingMembership) {
    if (existingMembership.status === "suspended") {
      throw new ServiceError(
        "CONFLICT",
        "Your membership in this organization is suspended. Ask an admin to reinstate you — an invitation cannot bypass a suspension.",
      );
    }
    // Idempotent success: mark the invitation used (conditionally — a lost
    // race just means someone else already marked it) and make sure the
    // member has a project to land on.
    await db.invitation.updateMany({
      where: { id: invitation.id, status: "pending" },
      data: { status: "accepted" },
    });
    const project = await attachMemberToProject(
      organizationId,
      userId,
      userEmail,
      invitation.projectId,
    );
    return {
      organizationId,
      organizationName,
      projectId: project.id,
      role: existingMembership.role,
      alreadyMember: true,
      invitationId: invitation.id,
    };
  }

  const { count } = await db.invitation.updateMany({
    where: { id: invitation.id, status: "pending" },
    data: { status: "accepted" },
  });
  if (count !== 1) {
    throw new ServiceError("GONE", "This invitation is no longer active.");
  }

  await db.organizationMember.upsert({
    where: { organizationId_userId: { organizationId, userId } },
    create: {
      organizationId,
      userId,
      userEmail,
      role: invitation.role,
    },
    update: {},
  });

  const project = await attachMemberToProject(
    organizationId,
    userId,
    userEmail,
    invitation.projectId,
  );

  return {
    organizationId,
    organizationName,
    projectId: project.id,
    role: invitation.role,
    alreadyMember: false,
    invitationId: invitation.id,
  };
};

/**
 * Resolve (or create) the DB user row for an authenticated invitee — the
 * accept path's replacement for the `/v1/auth/session` upsert, which a
 * brand-new invitee must NOT hit before accepting (it would bootstrap them
 * their own org).
 *
 * D-H: an email that already belongs to a DIFFERENT auth identity is REFUSED
 * (409, the same message the session route uses) — this path never silently
 * relinks an identity.
 */
export const resolveInviteeUser = async (
  externalAuthId: string,
  email: string,
  name?: string,
): Promise<{ id: string; email: string }> => {
  const byAuthId = await db.user.findUnique({
    where: { externalAuthId },
    select: { id: true, email: true },
  });
  if (byAuthId) return byAuthId;

  const byEmail = await db.user.findUnique({
    where: { email },
    select: { id: true, email: true, externalAuthId: true },
  });
  if (byEmail) {
    if (byEmail.externalAuthId === externalAuthId) {
      return { id: byEmail.id, email: byEmail.email };
    }
    throw new ServiceError("CONFLICT", IDENTITY_CONFLICT_ERROR);
  }

  const created = await db.user.create({
    data: {
      externalAuthId,
      email,
      name: name ?? null,
      lastLoginAt: new Date(),
    },
    select: { id: true, email: true },
  });
  return created;
};
