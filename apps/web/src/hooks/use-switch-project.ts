"use client";

import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/api/keys";
import { writeDefaultProjectCookie } from "@/lib/navigation";

/**
 * THE project-switch mechanism — the sidebar switcher and the projects page
 * both go through this one sequence, so the cookie write, cache drop and
 * server re-render can't drift apart between surfaces.
 */
export const useSwitchProject = () => {
  const router = useRouter();
  const queryClient = useQueryClient();

  const switchTo = (projectId: string) => {
    writeDefaultProjectCookie(projectId);
    // Belt and braces. `getProjectId()` returns the cookie, so `scope()`
    // already re-keys every query on switch; clearing also drops the old
    // project's entries instead of leaving them cached under a key nobody
    // will ask for again.
    queryClient.clear();
    // Seed the cookie query synchronously so every subscriber (the sidebar
    // label, the /projects Current badge) reflects the switch immediately
    // instead of holding stale local state across the async refetch.
    queryClient.setQueryData(queryKeys.scope.projectCookie(), projectId);
    // The cookie only reaches the server on the next request, and most of this
    // dashboard is server-rendered, so refresh rather than re-render.
    router.refresh();
  };

  return switchTo;
};
