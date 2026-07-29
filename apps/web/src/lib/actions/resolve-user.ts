"use server";

import "@/lib/init/server";
import { headers } from "next/headers";
import { db } from "@onecli/db";
import { getServerSession } from "@/lib/auth/server";
import {
  activeMembershipWhere,
  findUserDefaultProject,
} from "@onecli/api/services/organization-service";
import { canAccessProjectAsUser } from "@onecli/api/middleware/auth/resolve";

export interface UserContext {
  userId: string;
  userEmail: string;
  organizationId: string;
  projectId: string;
}

export interface ResolveOptions {
  fallbackToDefault?: boolean;
}

/**
 * Resolves the current authenticated user's ID, their organization, and the
 * active project. Tries the x-project-id header first (set by proxy.ts from
 * the URL path), then falls back to the user's default project (appropriate
 * for OSS where there is a single org/project).
 *
 * The header arm gates exactly like the API's `resolveProjectId`: SUSPENDED
 * memberships are filtered out (they are non-members to every authorization
 * check) and the project itself must pass `canAccessProjectAsUser`, so an
 * org-membership alone never grants a plain member access to a project they
 * hold no ProjectAccess binding on. Keeping the two surfaces identical is the
 * point — a header the API rejects must not open a dashboard context.
 */
export const resolveProjectContext = async (
  options?: ResolveOptions,
): Promise<UserContext> => {
  void options;
  const session = await getServerSession();
  if (!session) throw new Error("Not authenticated");

  const user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: {
      id: true,
      email: true,
      organizationMemberships: {
        where: activeMembershipWhere,
        select: { organizationId: true },
      },
    },
  });

  if (!user) throw new Error("User not found");

  const headerStore = await headers();
  const headerProjectId = headerStore.get("x-project-id");

  if (headerProjectId) {
    const memberOrgIds = user.organizationMemberships.map(
      (m) => m.organizationId,
    );
    const project = await db.project.findFirst({
      where: {
        id: headerProjectId,
        organizationId: { in: memberOrgIds },
      },
      select: { id: true, organizationId: true },
    });
    if (project && (await canAccessProjectAsUser(user.id, project))) {
      return {
        userId: user.id,
        userEmail: user.email,
        organizationId: project.organizationId,
        projectId: project.id,
      };
    }
  }

  const project = await findUserDefaultProject(user.id);
  if (!project) throw new Error("No project found");

  return {
    userId: user.id,
    userEmail: user.email,
    organizationId: project.organizationId,
    projectId: project.id,
  };
};
