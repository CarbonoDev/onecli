"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { projects } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { readDefaultProjectCookie } from "@/lib/navigation";
import { useSessionScope } from "./use-session-scope";

/** The caller's visible projects. Org comes from the URL scope by default; the
 * explicit organizationId override serves the account-route Get Started picker
 * (org from the default-org cookie, validated server-side). */
export const useProjectsList = (
  options: { organizationId?: string; enabled?: boolean } = {},
) =>
  useQuery({
    queryKey: queryKeys.projects.list(options.organizationId),
    queryFn: () => projects.list({ organizationId: options.organizationId }),
    enabled: options.enabled ?? true,
  });

// Project rename/delete go through the audited `/v1/projects/:id` routes. Delete
// flushes the gateway cache for the removed keys server-side, so there is
// nothing to flush client-side. Rename/delete invalidate the projects list so
// the switcher and the /projects table update in place; navigation (the
// settings page's refresh/redirect) stays with the caller.

/** The current project's row (name/slug/createdAt) for the settings page. */
export const useProject = (projectId: string | undefined) =>
  useQuery({
    queryKey: queryKeys.projects.detail(projectId ?? ""),
    queryFn: () => projects.get(projectId ?? ""),
    enabled: Boolean(projectId),
  });

/**
 * The project the server is actually operating in.
 *
 * Mirrors the resolution chain rather than guessing: the proxy sends the
 * switcher's cookie as `X-Project-Id`, `resolveProjectId` honours it when the
 * caller may reach it, and falls back to `findUserDefaultProject` otherwise.
 * So the selection wins when there is one, and the session's default answers
 * when there is not.
 *
 * The cookie is read through a query, not during render, because it lives on
 * `document` — reading it while rendering would mismatch the server-rendered
 * HTML (queries don't run on the server, so the `undefined` first paint is
 * preserved). A query rather than a mount effect because effects never re-run:
 * both switch surfaces call `queryClient.clear()`, which makes every
 * subscriber re-read the cookie after a switch from either one.
 *
 * Note the session endpoint reports the DEFAULT project, not the selected one
 * (it resolves through `findUserDefaultProject` and ignores the project
 * header), which is exactly why the cookie has to take precedence here. It
 * does honour the ORG header, so this fallback answers with a project from the
 * selected org rather than from the caller's own.
 */
export const useCurrentProjectId = (): string | undefined => {
  const cookie = useQuery({
    queryKey: queryKeys.scope.projectCookie(),
    // `null`, never `undefined` — react-query rejects undefined query data.
    queryFn: () => readDefaultProjectCookie() ?? null,
    staleTime: Infinity,
  });

  const resolved = useSessionScope();

  return cookie.data ?? resolved.data?.projectId;
};

export const useCreateProject = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => projects.create(name),
    onSuccess: () => {
      // The switcher must show the new project immediately; the caller decides
      // whether to also switch to it.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.list(),
      });
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : "Failed to create project",
      ),
  });
};

export const useRenameProject = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      projects.rename(id, name),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.all(),
      });
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : "Failed to rename project",
      ),
  });
};

export const useDeleteProject = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => projects.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.all(),
      });
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : "Failed to delete project",
      ),
  });
};
