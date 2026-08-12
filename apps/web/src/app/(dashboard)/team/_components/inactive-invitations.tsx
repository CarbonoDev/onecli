import { Badge } from "@onecli/ui/components/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@onecli/ui/components/table";
import { TableCard } from "@/components/table-card";
import type { InvitationRow } from "@/lib/api";

/** An invitation that will never become a member: it lapsed or was revoked. */
export type InactiveInvitation = InvitationRow & {
  status: "expired" | "cancelled";
};

export const isInactiveInvitation = (
  row: InvitationRow,
): row is InactiveInvitation =>
  row.status === "expired" || row.status === "cancelled";

export interface InactiveInvitationsProps {
  /** Never empty — the caller renders this table only when there is history. */
  invitations: InactiveInvitation[];
}

/**
 * Invitations that used to be pending. Kept out of the members table (nobody
 * here is a member, or ever will be on this link) and rendered only when
 * non-empty, so the common case is exactly the one-table target and nothing
 * silently vanishes when something did expire.
 */
export const InactiveInvitations = ({
  invitations,
}: InactiveInvitationsProps) => (
  <div className="space-y-3">
    <h2 className="text-sm font-medium">Expired and revoked invitations</h2>
    <TableCard>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Invitation</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invitations.map((row) => (
            <TableRow key={`x-${row.id}`}>
              <TableCell className="py-2.5">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{row.email}</span>
                  <span className="text-muted-foreground truncate text-xs">
                    Invited by {row.invitedByEmail}
                  </span>
                </div>
              </TableCell>
              <TableCell className="text-muted-foreground capitalize">
                {row.role}
              </TableCell>
              <TableCell>
                <Badge
                  variant="outline"
                  className="text-muted-foreground px-1.5 py-0 text-[10px] tracking-wider uppercase"
                >
                  {row.status === "cancelled" ? "Revoked" : "Expired"}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableCard>
  </div>
);
