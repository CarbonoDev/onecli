import { db } from "@onecli/db";
import type { OrgRole, RoleResolver } from "../providers";
import { ROLE_HIERARCHY } from "../providers";
import { logger } from "../lib/logger";

/**
 * The OSS edition's `RoleResolver`: the org-membership row IS the role source
 * of truth (no directory, no SSO mappings, no role automation).
 *
 * Wired through `CreateApiAppOptions.roleResolver` from the OSS init seam. It
 * is a HARD prerequisite for `CAPS.rbac`: with rbac on and no resolver every
 * access check reads "no role" and denies — `canAccessProjectAsUser`
 * (`middleware/auth/resolve.ts`), the org-key admin re-check
 * (`middleware/auth/api-key.ts`) and `auth({ role })` all fail closed. The
 * resolver and the capability flag must always ship together.
 */

const isOrgRole = (role: string): role is OrgRole =>
  Object.prototype.hasOwnProperty.call(ROLE_HIERARCHY, role);

const log = logger.child({ component: "oss-role-resolver" });

export const ossRoleResolver: RoleResolver = {
  getUserRole: async (
    userId: string,
    organizationId: string,
  ): Promise<OrgRole | null> => {
    const member = await db.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      select: { role: true, status: true },
    });

    // Not a member of this org.
    if (!member) return null;

    // Suspended members are non-members to every authorization check — the
    // same invariant `activeMembershipWhere` applies on the read side. Keeping
    // it here is what stops a stale ProjectAccess binding from rescuing a
    // suspended user (the binding check lives inside the active-member gate).
    if (member.status === "suspended") return null;

    // `role` is a free-form column. Never cast a raw DB string into `OrgRole`:
    // an unrecognized value (bad migration, hand-edited row, a role a newer
    // edition writes) resolves to "no role" and fails closed.
    if (!isOrgRole(member.role)) {
      log.warn(
        { userId, organizationId, role: member.role },
        "unrecognized organization member role — treating as no role",
      );
      return null;
    }

    return member.role;
  },
};
