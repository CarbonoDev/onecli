"use client";

import { useQuery } from "@tanstack/react-query";
import { usage } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

/**
 * Org-scope gateway usage for the rolling window.
 *
 * `retry: false` for the same reason `useBudgets` does it: a caller whose
 * credential can't carry org breadth gets a deterministic 403, and retrying a
 * settled authorization answer only delays the error state.
 */
export const useUsage = () =>
  useQuery({
    queryKey: queryKeys.usage.summary(),
    queryFn: usage.get,
    retry: false,
  });
