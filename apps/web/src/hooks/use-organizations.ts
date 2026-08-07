"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
 * The org the server is operating in.
 *
 * Cookie first, then whichever org the current project belongs to. That order
 * mirrors resolution: the proxy sends the cookie as `X-Organization-Id`,
 * `resolveProjectId` prefers that org's default project, and `session.ts`
 * then derives the org FROM the resolved project — so the cookie is upstream of
 * everything and has to win here too.
 *
 * Read in an effect, not during render: the cookie lives on `document`, and
 * reading it while rendering would mismatch the server-rendered HTML.
 */
export const useCurrentOrganizationId = (
  fallbackOrganizationId?: string,
): string | undefined => {
  const [cookieId, setCookieId] = useState<string | undefined>();
  useEffect(() => setCookieId(readDefaultOrgCookie()), []);
  return cookieId ?? fallbackOrganizationId;
};
