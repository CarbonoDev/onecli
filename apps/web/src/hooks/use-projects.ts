"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { projects } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

// Project rename/delete go through the audited `/v1/projects/:id` routes. Delete
// flushes the gateway cache for the removed keys server-side, so there is
// nothing to flush client-side. The projects list is server-rendered, so
// callers handle the on-success refresh/redirect themselves (as the old actions
// did) rather than invalidating a query cache.

/** The current project's row (name/slug/createdAt) for the settings page. */
export const useProject = (projectId: string | undefined) =>
  useQuery({
    queryKey: queryKeys.projects.detail(projectId ?? ""),
    queryFn: () => projects.get(projectId ?? ""),
    enabled: Boolean(projectId),
  });

/**
 * Every project the caller may use — the switcher's source.
 *
 * The API returns only what the caller can reach (`listProjects` mirrors
 * `canAccessProjectAsUser`), so there is nothing to filter here. A member with
 * no bindings gets an empty list rather than an error, which the switcher reads
 * as "nothing to switch to".
 */
export const useProjectsList = () =>
  useQuery({
    queryKey: queryKeys.projects.list(),
    queryFn: () => projects.list(),
  });

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

export const useRenameProject = () =>
  useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      projects.rename(id, name),
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : "Failed to rename project",
      ),
  });

export const useDeleteProject = () =>
  useMutation({
    mutationFn: (id: string) => projects.remove(id),
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : "Failed to delete project",
      ),
  });
