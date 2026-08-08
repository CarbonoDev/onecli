"use client";

import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { useOrgMembersList } from "@/hooks/use-org-members";
import { useInvitations } from "@/hooks/use-invitations";
import { LocalModeNotice } from "./local-mode-notice";
import { AdminOnlyNotice } from "./admin-only-notice";
import { MembersTable } from "./members-table";
import { PendingInvitations } from "./pending-invitations";

export interface TeamContentProps {
  /** Threaded from the RSC page (server-only auth mode); false = local mode. */
  teamEnabled: boolean;
}

export const TeamContent = ({ teamEnabled }: TeamContentProps) => {
  const members = useOrgMembersList(teamEnabled);
  // The members query's 403 is the admin authority (D-K): a non-admin gets a
  // deterministic error, so the invitations query never even starts for them.
  const isAdmin = !members.isError;
  const invitations = useInvitations(teamEnabled && isAdmin);

  if (!teamEnabled) return <LocalModeNotice />;

  if (members.isPending) {
    return (
      <div className="space-y-4">
        {[1, 2].map((i) => (
          <Card key={i} className="p-6">
            <div className="flex items-center justify-between">
              <div className="space-y-2">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-4 w-48" />
              </div>
              <Skeleton className="size-8 rounded-md" />
            </div>
          </Card>
        ))}
      </div>
    );
  }

  if (members.isError) return <AdminOnlyNotice />;

  return (
    <div className="space-y-6">
      <MembersTable members={members.data ?? []} />
      {/* A failed fetch must render as an error, never as "No invitations
          yet" — with retry:false an isError query has data undefined, which
          would otherwise fall into the empty state. */}
      <PendingInvitations
        invitations={invitations.data ?? []}
        loading={invitations.isPending}
        error={invitations.isError}
      />
    </div>
  );
};
