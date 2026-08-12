"use client";

import { useQuery } from "@tanstack/react-query";
import { session } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

/**
 * The org/project scope the SERVER resolved for this caller.
 *
 * The fallback behind both selection cookies: `useCurrentProjectId` and
 * `useCurrentOrganizationId` each prefer their cookie and land here when there
 * is none — which is the ordinary state for a user who has never used a
 * switcher, and for one who has just been dropped into a new org.
 *
 * Shared rather than duplicated per hook so the two answer from ONE request and
 * one cache entry: two independent session queries could report different
 * scopes to the org label and the project label on the same screen.
 *
 * `null` on failure rather than a throw — an unresolvable session must leave a
 * switcher unlabelled, not error the sidebar. `staleTime: Infinity` because a
 * switch drops the whole cache; nothing else changes this answer.
 */
export const useSessionScope = () =>
  useQuery({
    queryKey: queryKeys.scope.session(),
    queryFn: () => session.get().catch(() => null),
    staleTime: Infinity,
  });
