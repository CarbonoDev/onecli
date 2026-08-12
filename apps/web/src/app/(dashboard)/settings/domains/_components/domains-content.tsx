"use client";

import { Card, CardContent } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { useDomains } from "@/hooks/use-domains";
import { AddDomainForm } from "./add-domain-form";
import { AdminOnlyNotice } from "./admin-only-notice";
import { DomainsList } from "./domains-list";
import { LocalModeNotice } from "./local-mode-notice";

export interface DomainsContentProps {
  /** Threaded from the RSC page (server-only auth mode); false = local mode. */
  domainsEnabled: boolean;
}

export const DomainsContent = ({ domainsEnabled }: DomainsContentProps) => {
  // The query's 403 is the admin authority (the /groups pattern): a non-admin
  // gets a deterministic error and the surface renders the admin-only notice —
  // the API gates the whole router on admin anyway.
  const domains = useDomains(domainsEnabled);

  // Local mode has a single built-in identity on no real domain, so this is
  // inert — return before the query's pending/error branches so no doomed
  // request fires against an unreachable org backend.
  if (!domainsEnabled) return <LocalModeNotice />;

  if (domains.isPending) {
    return (
      <Card>
        <CardContent className="space-y-4">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-9 w-full max-w-xs" />
          <Skeleton className="h-[140px] w-full rounded-xl" />
        </CardContent>
      </Card>
    );
  }

  if (domains.isError) return <AdminOnlyNotice />;

  return (
    <Card>
      <CardContent className="space-y-6">
        <AddDomainForm />
        <DomainsList domains={domains.data ?? []} />
      </CardContent>
    </Card>
  );
};
