"use client";

import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { useOrgMembersList } from "@/hooks/use-org-members";
import { useInvitations } from "@/hooks/use-invitations";
import { LocalModeNotice } from "./local-mode-notice";
import { AdminOnlyNotice } from "./admin-only-notice";
import { MembersTable } from "./members-table";
import {
  InactiveInvitations,
  isInactiveInvitation,
} from "./inactive-invitations";
import { InvitationsErrorNotice } from "./invitations-error-notice";

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

  // A failed invitations fetch must render as an error next to a working
  // members table, never as "no invitations" — with retry:false an isError
  // query has data undefined, which would otherwise read as an empty list.
  const allInvitations = invitations.data ?? [];
  // Pending people join the members table; expired/revoked get their own table
  // below. `accepted` is rendered nowhere on purpose: that person already has a
  // member row, and repeating them as an invitation would double-count a
  // teammate on the page every time someone joins by link.
  const pending = allInvitations.filter((row) => row.status === "pending");
  const inactive = allInvitations.filter(isInactiveInvitation);

  return (
    <div className="space-y-6">
      <MembersTable members={members.data ?? []} invitations={pending} />
      {invitations.isError && <InvitationsErrorNotice />}
      {inactive.length > 0 && <InactiveInvitations invitations={inactive} />}
    </div>
  );
};
