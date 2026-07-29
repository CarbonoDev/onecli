"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { orgMembers } from "@/lib/api";
import type { UpdateOrgMemberInput } from "@/lib/api";
import { fetchAllPages } from "@/lib/api/pagination";
import { queryKeys } from "@/lib/api/keys";

const PAGE_LIMIT = 200;

/** Org members via the directory API (all pages) — the /team members table. */
export const useOrgMembersList = (enabled: boolean) =>
  useQuery({
    queryKey: queryKeys.orgMembers.list(),
    queryFn: () =>
      fetchAllPages((cursor) => orgMembers.list({ limit: PAGE_LIMIT, cursor })),
    enabled,
    // Directory routes are admin-only; a non-admin gets a deterministic 403,
    // which the team page RENDERS (its admin-only notice) rather than
    // retries — the API is the authority on who is an admin.
    retry: false,
  });

/**
 * Member mutations: lifecycle (suspend / reinstate) and org role
 * (admin / member) — one change per call. The members list is a client query
 * (`useOrgMembersList` feeds the /team table), so a successful change
 * invalidates it here.
 */
export const useUpdateOrgMember = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      userId,
      input,
    }: {
      userId: string;
      input: UpdateOrgMemberInput;
    }) => orgMembers.update(userId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.orgMembers.all() });
    },
    onError: (err) => toast.error(err.message),
  });
};
