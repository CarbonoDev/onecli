"use client";

import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/api/keys";
import {
  clearDefaultProjectCookie,
  writeDefaultOrgCookie,
  writeDefaultProjectCookie,
} from "@/lib/navigation";

export interface OrganizationScope {
  organizationId: string;
  /**
   * The project to land on inside that org — the org's default, resolved
   * server-side. `undefined` means "the caller can reach no project there":
   * the selection is cleared rather than left pointing at the previous org.
   */
  projectId?: string;
}

/**
 * THE org-switch mechanism — the sidebar switcher and the invitation accept
 * both go through this one sequence, so the cookie writes, the cache drop and
 * the re-render can't drift apart between surfaces (the `useSwitchProject`
 * precedent).
 *
 * The project is written HERE, together with the org, rather than being left
 * for the next request to resolve. Two reasons:
 *
 *  - A cleared project cookie makes the client's own idea of the current
 *    project fall back to `GET /v1/auth/session`, so the sidebar would show
 *    "Select project" until the user picked one by hand.
 *  - Under multi-org tenancy `resolveProjectId` refuses to guess at all when no
 *    project header arrives, so the new org would render with no project scope.
 *
 * Callers navigate afterwards (`router.refresh()` when staying put) — cookies
 * only reach the server on the NEXT request, and this dashboard reads its scope
 * from that request.
 */
export const useSwitchOrganization = () => {
  const queryClient = useQueryClient();

  return ({ organizationId, projectId }: OrganizationScope) => {
    writeDefaultOrgCookie(organizationId);
    // Non-negotiable: a project cookie from the PREVIOUS org would otherwise
    // win, because the project header takes precedence over the org header and
    // the org is derived from the resolved project.
    if (projectId) writeDefaultProjectCookie(projectId);
    else clearDefaultProjectCookie();

    // Everything cached belongs to the old org. The scope cookies re-key every
    // query, so keys do change on their own; clearing drops the old org's
    // entries rather than leaving them resident.
    queryClient.clear();

    // Re-seed AFTER the clear (which dropped these too), synchronously: every
    // `useCurrentOrganizationId` / `useCurrentProjectId` subscriber — the
    // switcher's own label, and any page already mounted — moves to the new
    // scope in the same render. The cookie queries would otherwise not re-read
    // until a remount, and `router.refresh()` does not remount client
    // components.
    queryClient.setQueryData(
      queryKeys.scope.organizationCookie(),
      organizationId,
    );
    queryClient.setQueryData(
      queryKeys.scope.projectCookie(),
      projectId ?? null,
    );
  };
};
