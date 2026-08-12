"use client";

import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/api/keys";
import { writeDefaultProjectCookie } from "@/lib/navigation";
import { useNavShell } from "./use-nav-shell";

/** Where entering a project lands. The project shell's first nav item, and the
 * same page `resolveHomeRedirect` sends `/` to. */
const PROJECT_HOME = "/overview";

/**
 * THE project-switch mechanism — the sidebar switcher, the projects table and
 * the create dialog all go through this one sequence, so the cookie write,
 * cache drop and server re-render can't drift apart between surfaces.
 *
 * The switch is SCOPE-AWARE, because the same click means two different things:
 *
 *  - From the ORG shell it means "enter this project", so it navigates into the
 *    project shell. Before the shell split this was invisible — Overview,
 *    Install and Agents sat in the one flat sidebar, so switching and then
 *    clicking Overview got you there. With the org shell carrying no
 *    project-scope items, a switch that only refreshed left the user on
 *    `/projects` with no way in at all.
 *  - From the PROJECT shell it means "change which project I'm looking at", so
 *    it stays put and refreshes. Someone on `/agents` wants that project's
 *    agents, not to be bounced to Overview.
 */
export const useSwitchProject = () => {
  const router = useRouter();
  const queryClient = useQueryClient();
  const shell = useNavShell();

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
    // Either way the cookie only reaches the server on the NEXT request, which
    // is why neither branch can just re-render: `push` issues one, `refresh`
    // re-issues the current one.
    if (shell === "project") router.refresh();
    else router.push(PROJECT_HOME);
  };

  return switchTo;
};
