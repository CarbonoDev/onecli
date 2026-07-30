import { db, Prisma } from "@onecli/db";
import { ServiceError } from "./errors";
import { logger } from "../lib/logger";
import { ROLE_HIERARCHY } from "../providers";
import type { OrgRole } from "../providers";
import {
  recordAuditEvent,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "./audit-service";
import { MAX_ROLE_MAPPINGS } from "../validations/org";
import type {
  CreateRoleMappingInput,
  PreviewRoleMappingInput,
  UpdateRoleMappingInput,
} from "../validations/org";

/**
 * Group → org-role mappings: the mapping CONFIG (list/create/update/delete/
 * reorder/preview) plus the engine that APPLIES it to `OrganizationMember.role`.
 * Scoped to ONE organization on every call — the caller's
 * `auth.organizationId`, never a body parameter — so this can never read or
 * write across orgs.
 *
 * WHEN IT APPLIES. In the cloud edition mappings are re-resolved at SSO login.
 * OSS has no SSO, so the apply is driven by writes instead: (a) every
 * membership write in `org-group-service.ts` calls
 * `applyRoleMappingsForGroup`, and (b) every mapping-config write in
 * `routes/org/role-mappings.ts` calls `applyOrgRoleMappings`.
 *
 * PRECEDENCE. `priority` is an ASCENDING rank — 0 wins. The FIRST mapping (by
 * `priority asc, createdAt asc, id asc`) whose group contains the user
 * decides that user's mapped role. Role strength plays NO part in choosing
 * the winner, which is what makes ordering load-bearing: a `member` mapping at
 * priority 0 SHADOWS an `admin` mapping at priority 3 for anyone in both
 * groups. That is the documented way to carve an exception out of a broad
 * grant.
 *
 * ── DECISION C: a mapping is a FLOOR, never a ceiling ────────────────────
 *
 * `OrganizationMember` has NO provenance column (`organizationId, userId,
 * userEmail, role, status, suspendedAt, ssoExempt, createdAt`), so the system
 * cannot tell a mapping-assigned `admin` from a hand-promoted one. Deriving
 * provenance from the audit log was rejected: audit writes are best-effort by
 * design (`logAuditEvent` swallows its own errors), and an authorization
 * decision must never hang off a log that is allowed to drop rows.
 *
 * The apply is therefore MONOTONIC — it may only ever RAISE a role:
 *
 *     target(U) = strongest(current(U), mappedRole(U))
 *     write iff target(U) !== current(U)   // i.e. iff it is a strict raise
 *
 * Consequences, all deliberate:
 *  - a `member` mapping demotes nobody; its only effect is shadowing;
 *  - removing a user from an `admin`-mapped group does not demote them — the
 *    grant sticks;
 *  - a mapping is a FLOOR, so `PATCH /v1/org/members/:userId` does NOT durably
 *    undo one. Hand-demoting a user who is STILL in a live `admin`-mapped
 *    group lasts only until the next apply, which re-raises them (the apply is
 *    a `max`, and it has no way to know the demotion was deliberate). The
 *    durable remedy is to remove the user from the mapped group, or to
 *    delete/reorder the mapping — THEN demote. Route-pinned in
 *    role-mappings.test.ts ("a hand-demoted member in an admin-mapped group is
 *    re-raised on the next apply");
 *  - the org's active-owner count is structurally unable to fall as a result
 *    of a mapping: owners are skipped in the resolver AND excluded by the
 *    `role: { not: "owner" }` predicate on both the candidate read and the
 *    write, so the apply never issues a statement that touches an owner row.
 *
 * IF YOU EVER ADD A PROVENANCE COLUMN to `OrganizationMember` (a `roleSource`
 * discriminator), `resolveRoleMappingChanges` below is the function to
 * revisit — it is the only place the raise-only rule is expressed.
 */

const log = logger.child({ component: "org-role-mappings" });

/** One row of the mappings list (matches the client's `RoleMappingRow`). */
export interface RoleMappingListRow {
  id: string;
  groupId: string;
  groupName: string;
  role: string;
  priority: number;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

/** A stored mapping, reduced to what resolution actually needs. */
export interface MappingRule {
  id: string;
  groupId: string;
  role: string;
  priority: number;
  createdAt: Date;
}

/** A candidate member's current state. */
export interface MemberState {
  userId: string;
  role: string;
  userEmail: string;
}

/** A single strict RAISE the apply will perform. */
export interface RoleChange {
  userId: string;
  userEmail: string;
  from: string;
  to: string;
  mappingId: string;
  groupId: string;
}

/**
 * Which seam fired the apply — carried into the MEMBER audit rows so an
 * operator can tell "someone joined a mapped group" from "someone edited the
 * mapping config" from "a group delete cascaded its mapping away".
 */
export type ApplyTrigger = "membership" | "mapping" | "group-deleted";

const ROW_SELECT = {
  id: true,
  groupId: true,
  role: true,
  priority: true,
  createdAt: true,
  updatedAt: true,
  group: { select: { name: true, _count: { select: { members: true } } } },
} as const;

const RULE_SELECT = {
  id: true,
  groupId: true,
  role: true,
  priority: true,
  createdAt: true,
} as const;

/** `priority asc, createdAt asc, id asc` — the ONE resolution order. */
const LIST_ORDER = [
  { priority: "asc" as const },
  { createdAt: "asc" as const },
  { id: "asc" as const },
];

interface MappingRowShape {
  id: string;
  groupId: string;
  role: string;
  priority: number;
  createdAt: Date;
  updatedAt: Date;
  group: { name: string; _count: { members: number } };
}

const toRow = (row: MappingRowShape): RoleMappingListRow => ({
  id: row.id,
  groupId: row.groupId,
  groupName: row.group.name,
  role: row.role,
  priority: row.priority,
  memberCount: row.group._count.members,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * The list is UNPAGED, by contract: `groupId` is unique so mappings are
 * bounded by group count, the client types the response as a bare array (not
 * a `DirectoryPage`), and resolution needs the whole ordered set anyway.
 */
export const listOrgRoleMappings = async (
  organizationId: string,
): Promise<RoleMappingListRow[]> => {
  const rows = await db.groupRoleMapping.findMany({
    where: { organizationId },
    select: ROW_SELECT,
    orderBy: LIST_ORDER,
  });
  return rows.map(toRow);
};

/**
 * Resolve a mapping WITHIN the caller's org — always
 * `findFirst({ id, organizationId })`, NEVER `findUnique({ where: { id } })`:
 * a cross-org id must read as absent (404), not leak another org's row.
 */
const requireMapping = async (organizationId: string, id: string) => {
  const mapping = await db.groupRoleMapping.findFirst({
    where: { id, organizationId },
    select: { id: true, groupId: true, role: true, priority: true },
  });
  if (!mapping) throw new ServiceError("NOT_FOUND", "Role mapping not found.");
  return mapping;
};

/**
 * Resolve the mapped group, org-scoped. Deliberately NOT the groups service's
 * `requireManualGroup`: a `GroupRoleMapping` is an admin-authored OneCLI
 * artifact, not an IdP-owned object, so mapping a `scim` group to a role is
 * the canonical use case rather than a conflict.
 */
const requireGroup = async (organizationId: string, groupId: string) => {
  const group = await db.group.findFirst({
    where: { id: groupId, organizationId },
    select: { id: true, name: true },
  });
  if (!group) throw new ServiceError("NOT_FOUND", "Group not found.");
  return group;
};

const readRow = async (organizationId: string, id: string) => {
  const row = await db.groupRoleMapping.findFirst({
    where: { id, organizationId },
    select: ROW_SELECT,
  });
  if (!row) throw new ServiceError("NOT_FOUND", "Role mapping not found.");
  return toRow(row);
};

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/**
 * Per-org advisory lock, cloned in spirit from `policy-service.ts`'s
 * `lockScope` (whose comment spells out why: an unlocked read-then-append can
 * mint duplicate priorities under concurrency). Not imported from there —
 * that helper is policy-scope-shaped.
 */
const lockOrgRoleMappings = (
  tx: Prisma.TransactionClient,
  organizationId: string,
) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`role-mappings:${organizationId}`}))`;

// ── Resolution ────────────────────────────────────────────────────────────

const isOrgRole = (role: string): role is OrgRole =>
  Object.prototype.hasOwnProperty.call(ROLE_HIERARCHY, role);

const byPrecedence = (a: MappingRule, b: MappingRule) =>
  a.priority - b.priority ||
  a.createdAt.getTime() - b.createdAt.getTime() ||
  a.id.localeCompare(b.id);

/**
 * PURE. No DB, no clock. Given the org's mapping set, who is in which mapped
 * group, and each candidate's current role, return the strict RAISES to
 * apply. Preview and apply both call this — which is what makes the preview
 * structurally incapable of lying about what the apply will do.
 *
 * `O(candidates × mappings)` with set lookups. Mappings are bounded by group
 * count on a single-instance OSS surface, so no index gymnastics are needed.
 */
export const resolveRoleMappingChanges = (input: {
  mappings: readonly MappingRule[];
  /** groupId → userIds, restricted to mapped groups. */
  membersByGroup: ReadonlyMap<string, ReadonlySet<string>>;
  candidates: readonly MemberState[];
  actorUserId: string;
}): RoleChange[] => {
  const { mappings, membersByGroup, candidates, actorUserId } = input;
  if (mappings.length === 0) return [];

  // Defensive: the loaders already order by this, but resolution must never
  // depend on the caller having done so.
  const ordered = [...mappings].sort(byPrecedence);
  const changes: RoleChange[] = [];

  for (const candidate of candidates) {
    // C2 — the acting user is skipped, mirroring `updateOrgMemberRole`'s "you
    // cannot change your own role". Under raise-only this can only ever fail
    // to promote the actor (fail-closed); anyone else's apply converges them.
    if (candidate.userId === actorUserId) continue;
    // C1 — owners are untouchable, so the org can never lose its last owner.
    if (candidate.role === "owner") continue;
    // C3 — never overwrite a role the system does not understand (the same
    // fail-closed stance `ossRoleResolver` takes for garbage role strings).
    if (!isOrgRole(candidate.role)) {
      log.warn(
        { userId: candidate.userId, role: candidate.role },
        "unrecognized organization member role — skipping role mapping",
      );
      continue;
    }

    const winner = ordered.find(
      (mapping) =>
        membersByGroup.get(mapping.groupId)?.has(candidate.userId) ?? false,
    );
    // Unmapped: the apply never touches this user.
    if (!winner) continue;
    if (!isOrgRole(winner.role)) {
      log.warn(
        { mappingId: winner.id, role: winner.role },
        "unrecognized role on a group role mapping — skipping",
      );
      continue;
    }

    // THE raise-only rule (decision C): write only on a strict raise.
    if (ROLE_HIERARCHY[winner.role] <= ROLE_HIERARCHY[candidate.role]) continue;

    changes.push({
      userId: candidate.userId,
      userEmail: candidate.userEmail,
      from: candidate.role,
      to: winner.role,
      mappingId: winner.id,
      groupId: winner.groupId,
    });
  }

  return changes;
};

// ── Applying ──────────────────────────────────────────────────────────────

type ApplyScope =
  | { kind: "org" }
  | {
      kind: "group";
      groupId: string;
      /** Ids the writer just REMOVED from the group (see below). */
      extraUserIds: readonly string[];
    };

const loadMappingRules = (organizationId: string): Promise<MappingRule[]> =>
  db.groupRoleMapping.findMany({
    where: { organizationId },
    select: RULE_SELECT,
    orderBy: LIST_ORDER,
  });

/**
 * Load the candidate members and the mapped groups' membership.
 * `scopedUserIds` narrows both reads to one group's members; `undefined`
 * means "every member of the org".
 */
const loadResolverState = async (
  organizationId: string,
  mappings: readonly MappingRule[],
  scopedUserIds: string[] | undefined,
) => {
  const scoped = scopedUserIds ? { userId: { in: scopedUserIds } } : {};

  // `role: { not: "owner" }` is decision C1 at the query layer; the resolver
  // repeats the skip so it stays correct in isolation (and under unit test).
  const candidates = await db.organizationMember.findMany({
    where: { organizationId, role: { not: "owner" }, ...scoped },
    select: { userId: true, role: true, userEmail: true },
  });

  const mappedGroupIds = [...new Set(mappings.map((m) => m.groupId))];
  const memberships = await db.groupMember.findMany({
    where: { groupId: { in: mappedGroupIds }, ...scoped },
    select: { groupId: true, userId: true },
  });

  const membersByGroup = new Map<string, Set<string>>();
  for (const row of memberships) {
    const set = membersByGroup.get(row.groupId);
    if (set) set.add(row.userId);
    else membersByGroup.set(row.groupId, new Set([row.userId]));
  }

  return { candidates, membersByGroup };
};

/**
 * The actor's email for the MEMBER audit rows (`AuditEventParams.userEmail` is
 * required). Resolved lazily — only on the path that already writes N rows.
 */
const resolveActorEmail = async (
  organizationId: string,
  actorUserId: string,
): Promise<string> => {
  const member = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId: actorUserId } },
    select: { userEmail: true },
  });
  if (member?.userEmail) return member.userEmail;
  const user = await db.user.findUnique({
    where: { id: actorUserId },
    select: { email: true },
  });
  return user?.email ?? "";
};

const applyRoleMappings = async (
  organizationId: string,
  actorUserId: string,
  scope: ApplyScope,
  trigger: ApplyTrigger,
): Promise<{ changed: number }> => {
  const mappings = await loadMappingRules(organizationId);
  // Short-circuit before touching membership: an org with no mappings has
  // nothing to resolve.
  if (mappings.length === 0) return { changed: 0 };

  let scopedUserIds: string[] | undefined;
  if (scope.kind === "group") {
    // Adding to (or removing from) an UNMAPPED group cannot change anybody's
    // mapped set — the winner is chosen only among mapped groups.
    if (!mappings.some((m) => m.groupId === scope.groupId))
      return { changed: 0 };
    const rows = await db.groupMember.findMany({
      where: { groupId: scope.groupId },
      select: { userId: true },
    });
    // The candidate set is this group's members AFTER the write, UNIONED with
    // the ids the writer just removed. The union is what makes the removal
    // paths converge: a user dropped from a high-priority `member` group that
    // was SHADOWING a lower-priority `admin` mapping must be re-resolved
    // against the mappings that still cover them (the unshadow case decision E
    // handles org-wide for `deleteOrgGroup`), and the post-write read can no
    // longer see them. The membership load below is filtered on the same id
    // list, so a removed user simply has no row for this group and falls
    // through to the next mapping — the resolver stays exactly as correct.
    scopedUserIds = [
      ...new Set([...rows.map((row) => row.userId), ...scope.extraUserIds]),
    ];
    // Nothing to resolve only when the union is empty — removing the LAST
    // member of a mapped group still has that member as a candidate.
    if (scopedUserIds.length === 0) return { changed: 0 };
  }

  const { candidates, membersByGroup } = await loadResolverState(
    organizationId,
    mappings,
    scopedUserIds,
  );

  const changes = resolveRoleMappingChanges({
    mappings,
    membersByGroup,
    candidates,
    actorUserId,
  });
  // Idempotence made observable: `strongest(current, mapped)` is a max over a
  // total order, so a converged org produces an empty change set — and we
  // return BEFORE opening any transaction (the `setOrgGroupMembers` no-delta
  // precedent), writing zero rows and zero audit events.
  if (changes.length === 0) return { changed: 0 };

  const byRole = new Map<string, string[]>();
  for (const change of changes) {
    const ids = byRole.get(change.to);
    if (ids) ids.push(change.userId);
    else byRole.set(change.to, [change.userId]);
  }

  await db.$transaction(
    [...byRole].map(([role, userIds]) =>
      db.organizationMember.updateMany({
        // `role: { not: "owner" }` again: the last-owner invariant enforced at
        // the WRITE layer, so even a resolver bug cannot lower an owner.
        where: {
          organizationId,
          userId: { in: userIds },
          role: { not: "owner" },
        },
        data: { role },
      }),
    ),
  );

  // Audits are written AFTER the transaction commits, never inside it: a
  // swallowed audit error must not roll back a role change. `recordAuditEvent`
  // deliberately does NOT flush the gateway cache — every caller of the apply
  // is already inside a `withAudit` carrying `organizationId`, which flushes
  // once at the end of the request. Do not "fix" this into N flushes.
  const actorEmail = await resolveActorEmail(organizationId, actorUserId);
  for (const change of changes) {
    await recordAuditEvent({
      organizationId,
      userId: actorUserId,
      userEmail: actorEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.MEMBER,
      source: AUDIT_SOURCE.API,
      metadata: {
        targetUserId: change.userId,
        role: change.to,
        previousRole: change.from,
        // THE discriminator: what lets an operator answer "why is this person
        // suddenly an admin?" from the audit log alone (the `via:
        // "invitation"` precedent in audit-service.ts).
        via: "role-mapping",
        mappingId: change.mappingId,
        groupId: change.groupId,
        trigger,
      },
    });
  }

  return { changed: changes.length };
};

/**
 * Re-resolve mapped org roles after a change to ONE group's membership.
 * Called by the three membership writers in `org-group-service.ts`.
 *
 * `extraUserIds` are the ids the caller just REMOVED from the group: they are
 * gone from the group by the time this runs, so the caller is the only thing
 * that still knows they need re-resolving. Adders pass nothing.
 */
export const applyRoleMappingsForGroup = (
  organizationId: string,
  groupId: string,
  actorUserId: string,
  extraUserIds: readonly string[] = [],
): Promise<{ changed: number }> =>
  applyRoleMappings(
    organizationId,
    actorUserId,
    { kind: "group", groupId, extraUserIds },
    "membership",
  );

/**
 * Re-resolve every member's mapped role. Called by the mapping-config routes
 * (a create/update/reorder/delete can change who wins for any group) and by
 * `deleteOrgGroup`, whose cascade can UNSHADOW a lower-priority mapping.
 */
export const applyOrgRoleMappings = (
  organizationId: string,
  actorUserId: string,
  trigger: ApplyTrigger = "mapping",
): Promise<{ changed: number }> =>
  applyRoleMappings(organizationId, actorUserId, { kind: "org" }, trigger);

// ── CRUD ──────────────────────────────────────────────────────────────────

export const createOrgRoleMapping = async (
  organizationId: string,
  actorUserId: string,
  input: CreateRoleMappingInput,
): Promise<{ mapping: RoleMappingListRow; rolesChanged: number }> => {
  await requireGroup(organizationId, input.groupId);

  // `groupId` is UNIQUE — at most one mapping per group. Friendly pre-check
  // for the common case; the P2002 catch below covers the create-create race
  // the pre-check cannot see (the `createOrgGroup` shape).
  const dupe = await db.groupRoleMapping.findFirst({
    where: { groupId: input.groupId },
    select: { id: true },
  });
  if (dupe) {
    throw new ServiceError(
      "CONFLICT",
      "This group already has a role mapping.",
    );
  }

  let createdId: string;
  try {
    const created = await db.$transaction(async (tx) => {
      await lockOrgRoleMappings(tx, organizationId);
      // The set ceiling, checked under the same lock as the append so a race
      // cannot slip past it. This is what keeps `PUT /order` reachable: the
      // reorder body must be able to name every mapping at once
      // (MAX_ROLE_MAPPINGS in validations/org.ts spells out the invariant).
      const total = await tx.groupRoleMapping.count({
        where: { organizationId },
      });
      if (total >= MAX_ROLE_MAPPINGS) {
        throw new ServiceError(
          "CONFLICT",
          `An organization can have at most ${MAX_ROLE_MAPPINGS} role mappings.`,
        );
      }
      // Append at max+1 (0 for the first mapping). Priorities are a RELATIVE
      // rank and need not be dense — a cascade delete leaves holes, and
      // resolution only ever compares them.
      const agg = await tx.groupRoleMapping.aggregate({
        where: { organizationId },
        _max: { priority: true },
      });
      const priority = input.priority ?? (agg._max.priority ?? -1) + 1;
      return tx.groupRoleMapping.create({
        data: {
          organizationId,
          groupId: input.groupId,
          role: input.role,
          priority,
        },
        select: { id: true },
      });
    });
    createdId = created.id;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ServiceError(
        "CONFLICT",
        "This group already has a role mapping.",
      );
    }
    throw err;
  }

  // Outside the transaction: the apply writes member rows and audit rows, and
  // must not hold the mapping lock while it does.
  const { changed } = await applyOrgRoleMappings(organizationId, actorUserId);
  return {
    mapping: await readRow(organizationId, createdId),
    rolesChanged: changed,
  };
};

export const updateOrgRoleMapping = async (
  organizationId: string,
  actorUserId: string,
  id: string,
  input: UpdateRoleMappingInput,
): Promise<{ mapping: RoleMappingListRow; rolesChanged: number }> => {
  await requireMapping(organizationId, id);

  // Org-scoped conditional write (the `renameOrgGroup` pattern): a count of 0
  // means the row vanished between the check and the write — a 404, not the
  // P2025 500 a bare `update()` would surface.
  const { count } = await db.groupRoleMapping.updateMany({
    where: { id, organizationId },
    data: {
      role: input.role,
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
    },
  });
  if (count === 0)
    throw new ServiceError("NOT_FOUND", "Role mapping not found.");

  const { changed } = await applyOrgRoleMappings(organizationId, actorUserId);
  return { mapping: await readRow(organizationId, id), rolesChanged: changed };
};

export const deleteOrgRoleMapping = async (
  organizationId: string,
  actorUserId: string,
  id: string,
): Promise<{
  id: string;
  groupId: string;
  role: string;
  rolesChanged: number;
}> => {
  const mapping = await requireMapping(organizationId, id);

  const { count } = await db.groupRoleMapping.deleteMany({
    where: { id, organizationId },
  });
  if (count === 0)
    throw new ServiceError("NOT_FOUND", "Role mapping not found.");

  // The UNSHADOW case: removing a high-priority `member` mapping can promote
  // everyone it was suppressing, so the delete re-resolves the whole org.
  const { changed } = await applyOrgRoleMappings(organizationId, actorUserId);
  return {
    id: mapping.id,
    groupId: mapping.groupId,
    role: mapping.role,
    rolesChanged: changed,
  };
};

export const reorderOrgRoleMappings = async (
  organizationId: string,
  actorUserId: string,
  orderedIds: string[],
): Promise<{ mappings: RoleMappingListRow[]; rolesChanged: number }> => {
  try {
    await db.$transaction(async (tx) => {
      // Validate + write under the same per-org lock `create` takes, so a
      // reorder cannot interleave with a concurrent append.
      await lockOrgRoleMappings(tx, organizationId);
      const current = await tx.groupRoleMapping.findMany({
        where: { organizationId },
        select: { id: true, priority: true },
        orderBy: LIST_ORDER,
      });
      const ids = new Set(current.map((row) => row.id));
      const namesEveryMappingOnce =
        orderedIds.length === ids.size &&
        new Set(orderedIds).size === orderedIds.length &&
        orderedIds.every((id) => ids.has(id));
      if (!namesEveryMappingOnce) {
        throw new ServiceError(
          "CONFLICT",
          "Role mapping set changed — refresh and try again.",
        );
      }

      // No-delta early return (the `setOrgGroupMembers` convention): the
      // stored order already IS the requested one and priorities are already
      // dense `0..n-1`, so there is nothing to write.
      const settled = current.every(
        (row, i) => row.id === orderedIds[i] && row.priority === i,
      );
      if (settled) return;

      // Ascending, 0-based: index 0 → priority 0 (highest precedence).
      for (const [i, id] of orderedIds.entries()) {
        await tx.groupRoleMapping.update({
          where: { id },
          data: { priority: i },
        });
      }
    });
  } catch (err) {
    // A delete committed between the in-tx read and an update (deletes don't
    // take the lock) surfaces as P2025 — same staleness, same 409.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2025"
    ) {
      throw new ServiceError(
        "CONFLICT",
        "Role mapping set changed — refresh and try again.",
      );
    }
    throw err;
  }

  // Runs even on the settled path: it is the only thing that converges an org
  // whose mapping set was edited out of band, and it is a no-op when nothing
  // changed.
  const { changed } = await applyOrgRoleMappings(organizationId, actorUserId);
  return {
    mappings: await listOrgRoleMappings(organizationId),
    rolesChanged: changed,
  };
};

/**
 * Dry run for the create/edit dialog: how many members the proposed mapping
 * would RAISE. Zero writes, zero audit rows — it is a POST only because the
 * client made it one.
 *
 * Because the count only ever counts raises, a `member` mapping (and an
 * `admin → member` edit) previews as `0`. That is truthful: such a mapping's
 * effect is shadowing, not demotion.
 */
export const previewOrgRoleMapping = async (
  organizationId: string,
  actorUserId: string,
  input: PreviewRoleMappingInput,
): Promise<{ affectedCount: number }> => {
  // Org-scoped: a preview against a foreign group must not leak its existence.
  await requireGroup(organizationId, input.groupId);

  const stored = await loadMappingRules(organizationId);
  const existing = stored.find((m) => m.groupId === input.groupId);
  const proposed: MappingRule[] = existing
    ? // An existing mapping keeps its SLOT — only the role is proposed, so a
      // shadowed group correctly previews as 0.
      stored.map((m) =>
        m.groupId === input.groupId ? { ...m, role: input.role } : m,
      )
    : [
        ...stored,
        {
          id: "preview",
          groupId: input.groupId,
          role: input.role,
          // Mirrors create's default, so the preview matches what the create
          // button will actually do.
          priority:
            stored.reduce((max, m) => Math.max(max, m.priority), -1) + 1,
          createdAt: new Date(),
        },
      ];

  const { candidates, membersByGroup } = await loadResolverState(
    organizationId,
    proposed,
    undefined,
  );

  // Same resolver, same actor: the preview inherits the owner skip, the self
  // skip and the raise-only rule, and therefore cannot over-promise.
  const changes = resolveRoleMappingChanges({
    mappings: proposed,
    membersByGroup,
    candidates,
    actorUserId,
  });
  return { affectedCount: changes.length };
};
