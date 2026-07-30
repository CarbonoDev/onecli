"use client";

import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { budgets, secrets } from "@/lib/api";
import type { CreateBudgetInput, UpdateBudgetInput } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

// Budget mutations are headless on the gateway cache: the audited API routes
// invalidate it server-side (withAudit keyed off organizationId).

/** LLM secret types the gateway can meter (must match budget-service). */
const METERED_TYPES = ["anthropic", "openai"];

export const useBudgets = () =>
  useQuery({
    queryKey: queryKeys.budgets.list(),
    queryFn: budgets.list,
    // A member (non-admin) gets a 403; surface it as an empty admin-only state
    // rather than retrying.
    retry: false,
  });

/**
 * The org's metered LLM secrets, for the create picker. Reads the org-scoped
 * secrets endpoint (admin-gated) and keeps only meterable types.
 */
export const useMeteredSecrets = (enabled = true) => {
  const query = useQuery({
    queryKey: [...queryKeys.secrets.all(), "organization", "metered"],
    queryFn: () => secrets.listScoped("organization"),
    enabled,
    retry: false,
  });
  const metered = useMemo(
    () => (query.data ?? []).filter((s) => METERED_TYPES.includes(s.type)),
    [query.data],
  );
  return { ...query, data: metered };
};

export const useCreateBudget = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBudgetInput) => budgets.create(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.budgets.all() });
      toast.success("Budget created");
    },
    onError: (err: Error) =>
      toast.error(err.message || "Failed to create budget"),
  });
};

export const useUpdateBudget = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateBudgetInput }) =>
      budgets.update(id, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.budgets.all() });
      toast.success("Budget updated");
    },
    onError: (err: Error) =>
      toast.error(err.message || "Failed to update budget"),
  });
};

export const useDeleteBudget = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => budgets.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.budgets.all() });
      toast.success("Budget removed");
    },
    onError: (err: Error) =>
      toast.error(err.message || "Failed to remove budget"),
  });
};
