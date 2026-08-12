"use client";

import { Card, CardContent } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { useDomains } from "@/hooks/use-domains";
import { ApiError } from "@/lib/api";
import { LoadErrorNotice } from "@/components/load-error-notice";
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

  // Only a 403 means "you are not an admin". Everything else — a 500, an
  // expired session, a dead API container — is a load failure, and telling an
  // admin they lack a permission they hold would hide the real problem.
  if (domains.isError) {
    return domains.error instanceof ApiError && domains.error.status === 403 ? (
      <AdminOnlyNotice />
    ) : (
      <LoadErrorNotice
        title="Couldn't load domains"
        message={domains.error.message}
        onRetry={() => void domains.refetch()}
      />
    );
  }

  return (
    <Card>
      <CardContent className="space-y-6">
        <AddDomainForm />
        <DomainsList domains={domains.data ?? []} />
      </CardContent>
    </Card>
  );
};
