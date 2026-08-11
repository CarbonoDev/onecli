"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { organizations } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { readDefaultOrgCookie } from "@/lib/navigation";

/**
 * The organizations the caller is an active member of — the org switcher's
 * source. Returns only the caller's memberships, so there is nothing to filter
 * client-side; a single-org user gets a one-item list.
 */
export const useOrganizationsList = () =>
  useQuery({
    queryKey: queryKeys.organizations.list(),
    queryFn: () => organizations.list(),
  });

/**
 * Rename an organization. Owns no cache — the invalidation belongs to the
 * component that knows which queries its rename invalidates (the
 * `useRenameProject` precedent).
 */
export const useRenameOrganization = () =>
  useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      organizations.rename(id, name),
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : "Failed to rename organization",
      ),
  });

/**
 * The org the server is operating in.
 *
 * Cookie first, then whichever org the current project belongs to. That order
 * mirrors resolution: the proxy sends the cookie as `X-Organization-Id`,
 * `resolveProjectId` prefers that org's default project, and `session.ts`
 * then derives the org FROM the resolved project — so the cookie is upstream of
 * everything and has to win here too.
 *
 * The cookie is held in the QUERY CACHE rather than in a mount effect. It has to
 * be: an effect with an empty dep array runs once, and `router.refresh()` — all
 * the org switcher does after writing the cookie — leaves client state alone. A
 * page mounted BEFORE the switch would keep resolving the old org forever, and
 * act on it (the org settings page would PATCH org A while the request carried
 * org B's header, producing a 404 the user cannot explain). As a query, the
 * switcher's `setQueryData` re-renders every subscriber at once.
 *
 * Still not read during render: the query function runs after hydration, so the
 * first paint matches the server-rendered HTML and falls back to
 * `fallbackOrganizationId` until the cookie answers.
 */
export const useCurrentOrganizationId = (
  fallbackOrganizationId?: string,
): string | undefined => {
  // `?? null` because react-query forbids `undefined` as query data — "no
  // cookie" has to be a value it can cache, not an absence it treats as unset.
  const { data: cookieId } = useQuery({
    queryKey: queryKeys.scope.organizationCookie(),
    queryFn: () => readDefaultOrgCookie() ?? null,
    staleTime: Infinity,
  });
  return cookieId ?? fallbackOrganizationId;
};
