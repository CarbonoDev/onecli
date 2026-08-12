"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { connections, vaults } from "@/lib/api";
import type { PageScope } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

// Connection mutations are headless on the gateway cache: the audited API
// routes invalidate it server-side (withAudit), so there is no client-side
// gateway call here.

export const useConnections = (scope: PageScope = "project", enabled = true) =>
  useQuery({
    queryKey: queryKeys.connections.list(scope),
    queryFn: () => connections.list(scope),
    enabled,
    // `/v1/org/connections` is admin-gated: a member's 403 is a deterministic
    // role boundary, not a transport blip, and retrying it only delays the
    // notice the page renders.
    //
    // A CONDITIONAL SPREAD, not `retry: cond ? false : undefined`. React Query
    // merges options with a plain object spread, so a key that is PRESENT with
    // value `undefined` still overwrites the client default — `retry: 1` from
    // `query-provider.tsx` would become `undefined`, and the retryer's own
    // `config.retry ?? 3` fallback would then triple project-scope retries.
    // The key has to be absent, not undefined.
    ...(scope === "organization" ? { retry: false as const } : {}),
  });

export const useVaultConnections = (enabled = true) =>
  useQuery({
    queryKey: queryKeys.vaults.list(),
    queryFn: vaults.list,
    enabled,
  });

export const useRenameConnection = (scope: PageScope = "project") => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) =>
      connections.rename(id, label, scope),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.connections.all() });
    },
    onError: () => toast.error("Failed to rename connection"),
  });
};

export const useDisconnectConnection = (scope: PageScope = "project") => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => connections.disconnect(id, scope),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.connections.all() });
      qc.invalidateQueries({ queryKey: queryKeys.counts.all() });
    },
    onError: () => toast.error("Failed to disconnect"),
  });
};
