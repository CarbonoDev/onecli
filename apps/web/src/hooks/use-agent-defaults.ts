"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { agentDefaults } from "@/lib/api";
import type { ConnectionGrantInput } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

// The project-level default-connections template: what a brand-new agent in
// this project is granted automatically. Mutations are audited server-side
// (withAudit), so — same as useConnections — there is no client-side gateway
// call here, just a refetch of the template.

export const useAgentDefaults = () =>
  useQuery({
    queryKey: queryKeys.agentDefaults.all(),
    queryFn: agentDefaults.list,
  });

export const useSetAgentDefault = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      connectionId,
      input,
    }: {
      connectionId: string;
      input: ConnectionGrantInput;
    }) => agentDefaults.set(connectionId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.agentDefaults.all() });
    },
    onError: () => toast.error("Failed to update the default"),
  });
};

export const useRemoveAgentDefault = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) => agentDefaults.remove(connectionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.agentDefaults.all() });
    },
    onError: () => toast.error("Failed to remove the default"),
  });
};
