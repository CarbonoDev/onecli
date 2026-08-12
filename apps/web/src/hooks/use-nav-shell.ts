"use client";

import { usePathname } from "next/navigation";
import { resolveNavShell, type NavShell } from "@/lib/nav-config";
import { useProjectsList } from "./use-projects";

/**
 * The shell the current page renders in — the sidebar's nav list and the
 * header's breadcrumb read this same hook, so the two can never disagree.
 *
 * The route table decides it (`resolveNavShell`), with one override the route
 * cannot know about: a caller with NO projects. `resolveHomeRedirect` sends
 * `/` to `/overview` unconditionally, and `getDashboardRedirect` only bounces
 * to `/create-org` when there is neither an org NOR a project — so an admin
 * who just deleted their last project lands on a project page with no project
 * behind it: project nav, a back link, a breadcrumb naming a project that is
 * gone, and a `ProjectSwitcher` that renders nothing on an empty list. The org
 * shell is the honest answer there, and it is the scope where the user can
 * actually create the project that gets them out.
 *
 * Gated on the list having LOADED. `undefined` means "still fetching", which
 * is not emptiness — treating it as such would flip the sidebar out of project
 * scope on the first paint of every project page.
 *
 * The query key is the one `ProjectSwitcher` already subscribes to, so this
 * costs no extra request.
 */
export const useNavShell = (): NavShell => {
  const pathname = usePathname();
  const { data: projects } = useProjectsList();

  if (projects?.length === 0) return "org";
  return resolveNavShell(pathname);
};
