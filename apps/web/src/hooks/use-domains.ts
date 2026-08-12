"use client";

// No client-side gateway flush here: domain mutations run through audited API
// routes that flush the gateway server-side (withAudit's org invalidation).

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { domains } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

export const useDomains = (enabled = true) =>
  useQuery({
    queryKey: queryKeys.domains.list(),
    queryFn: () => domains.list(),
    enabled,
    // The route is admin-only; a non-admin gets a deterministic 403, which is
    // expected, not retryable (the /groups precedent).
    retry: false,
  });

export const useClaimDomain = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (domain: string) => domains.claim(domain),
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: queryKeys.domains.all() });
      // Deliberately not "verified": the claim is an assertion until DNS backs
      // it, and the toast must not imply otherwise.
      toast.success(
        `${row.domain} added — publish the TXT record to verify it`,
      );
    },
    // Surface the server reason (already claimed, not a valid domain).
    onError: (err) => toast.error(err.message),
  });
};

/**
 * NO `onError` toast, and that is the point.
 *
 * A failed check is not a state the domain is in — it is what one lookup saw,
 * and DNS may propagate a minute later. The outcome therefore stays with the
 * row that asked for it: each `DomainRow` calls this hook itself, so
 * `mutation.error` is naturally per-row, and it renders inline next to the
 * record the caller still has to publish. A toast would detach the reason from
 * the record it is about and outlive the check that produced it.
 */
export const useVerifyDomain = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (domainId: string) => domains.verify(domainId),
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: queryKeys.domains.all() });
      toast.success(`${row.domain} verified`);
    },
  });
};

export const useDeleteDomain = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (domainId: string) => domains.remove(domainId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.domains.all() });
      toast.success("Domain removed");
    },
    onError: (err) => toast.error(err.message),
  });
};
