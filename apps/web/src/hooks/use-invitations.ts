"use client";

// No client-side gateway flush here: invitation mutations run through audited
// API routes that flush the gateway server-side (withAudit's org invalidation).

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { invitations } from "@/lib/api";
import type { CreateInvitationInput } from "@/lib/api";
import { fetchAllPages } from "@/lib/api/pagination";
import { queryKeys } from "@/lib/api/keys";

// The API pages with cursors (§3.5); the UI drains all pages and filters
// client-side (the connection-agents dialog pattern).
const PAGE_LIMIT = 200;

export const useInvitations = (enabled: boolean) =>
  useQuery({
    queryKey: queryKeys.invitations.list(),
    queryFn: () =>
      fetchAllPages((cursor) =>
        invitations.list({ limit: PAGE_LIMIT, cursor }),
      ),
    enabled,
    // Directory routes are admin-only; a non-admin gets a deterministic 403,
    // which is expected, not retryable (mirrors useOrgMembersList).
    retry: false,
  });

export const useCreateInvitation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateInvitationInput) => invitations.create(input),
    // No success toast: the invite dialog switches to its copy-link state,
    // which IS the success feedback.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.invitations.all() });
    },
    // Surface the server reason (already a member, pending invite, cap).
    onError: (err) => toast.error(err.message),
  });
};

export const useRevokeInvitation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) => invitations.revoke(invitationId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.invitations.all() });
      toast.success("Invitation revoked");
    },
    onError: (err) => toast.error(err.message),
  });
};
