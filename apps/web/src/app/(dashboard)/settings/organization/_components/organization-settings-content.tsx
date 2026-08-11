"use client";

import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import {
  useCurrentOrganizationId,
  useOrganizationsList,
} from "@/hooks/use-organizations";
import { ReadOnlyNotice } from "../../_components/read-only-notice";
import { OrganizationNameCard } from "./organization-name-card";

export interface OrganizationSettingsContentProps {
  /**
   * SSR-resolved org id, used only until the cookie query answers. Optional:
   * the server has no obligation to resolve one (a projectless user in a
   * cookie-less session resolves nothing), and the client is the authority.
   */
  fallbackOrganizationId?: string;
}

export const OrganizationSettingsContent = ({
  fallbackOrganizationId,
}: OrganizationSettingsContentProps) => {
  const organizationId = useCurrentOrganizationId(fallbackOrganizationId);
  // `GET /v1/organizations` already carries the caller's ROLE in each row, so
  // this one query answers both "what is this org called" and "may I rename
  // it" — no admin probe, and it is the switcher's query, so the rename below
  // invalidates exactly the cache the switcher reads.
  const list = useOrganizationsList();

  // The one-membership arm is not a convenience: a cookie-less single-org user
  // whose org has no project resolves NOTHING server-side and nothing from the
  // cookie either, and their sole membership is unambiguously the org this page
  // is about. With two or more it genuinely is ambiguous, so that stays an
  // error rather than a guess.
  const organization =
    list.data?.find((row) => row.id === organizationId) ??
    (list.data?.length === 1 ? list.data[0] : undefined);

  if (list.isPending) {
    return (
      <Card className="p-6">
        <div className="space-y-3">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-9 w-full max-w-sm" />
        </div>
      </Card>
    );
  }

  if (list.isError || !organization) {
    // A plain card: no retry, no toast — the failure is deterministic.
    return (
      <Card className="p-6">
        <p className="text-sm font-medium">
          Couldn&apos;t load this organization
        </p>
        <p className="text-muted-foreground mt-1 text-xs">
          Something went wrong fetching the organization. Reload the page to try
          again.
        </p>
      </Card>
    );
  }

  // A DISPLAY hint, never an authorization decision — the API's 403 is the
  // authority, and the rename surfaces its message as a toast.
  const canManage =
    organization.role === "admin" || organization.role === "owner";

  return (
    <>
      {!canManage && (
        <ReadOnlyNotice description="Only an organization admin or owner can rename this organization." />
      )}
      <OrganizationNameCard organization={organization} canManage={canManage} />
    </>
  );
};
