"use client";

import { Badge } from "@onecli/ui/components/badge";
import { TableCell, TableRow } from "@onecli/ui/components/table";
import type { InvitationRow as InvitationRowData } from "@/lib/api";
import { MemberAvatar } from "./member-avatar";
import { InvitationRowActions } from "./invitation-row-actions";

export interface InvitationRowProps {
  /** PENDING only — a lapsed or revoked invitation is not a member-to-be. */
  invitation: InvitationRowData;
}

/**
 * "expires in 6d" / "expires in 3h". The API projects a lapsed `pending` row as
 * `expired`, so this only narrates a future instant — the `<= 0` branch is the
 * clock-skew guard that keeps "expires in -1d" off the screen.
 */
const formatExpiry = (expiresAt: string) => {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return "expired";
  const hours = Math.floor(diff / (60 * 60 * 1000));
  if (hours < 1) return "expires in <1h";
  if (hours < 24) return `expires in ${hours}h`;
  return `expires in ${Math.floor(hours / 24)}d`;
};

/**
 * A pending invitation, rendered as a member row so the page answers "who is in
 * this org" in one table. Amber `INVITED` follows the in-repo pending idiom
 * (`Badge variant="outline"` + amber classNames) rather than a new Badge
 * variant — `packages/ui` stays shadcn territory.
 */
export const InvitationRow = ({ invitation }: InvitationRowProps) => (
  <TableRow>
    <TableCell className="py-2.5">
      <div className="flex items-center gap-3">
        <MemberAvatar email={invitation.email} />
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium">{invitation.email}</span>
            <Badge
              variant="outline"
              className="border-amber-500/40 bg-amber-500/10 px-1.5 py-0 text-[10px] tracking-wider text-amber-700 uppercase dark:text-amber-400"
            >
              Invited
            </Badge>
          </div>
          {/* The "Invited by" and "Expires" columns of the old table, folded
              into one muted line so the table keeps the target's 3 columns
              without losing either fact. */}
          <span className="text-muted-foreground truncate text-xs">
            Invited by {invitation.invitedByEmail} ·{" "}
            {formatExpiry(invitation.expiresAt)}
          </span>
        </div>
      </div>
    </TableCell>
    <TableCell className="text-muted-foreground capitalize">
      {invitation.role}
    </TableCell>
    <TableCell className="text-right">
      <InvitationRowActions invitation={invitation} />
    </TableCell>
  </TableRow>
);
