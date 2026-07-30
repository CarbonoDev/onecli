"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
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
