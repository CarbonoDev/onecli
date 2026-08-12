"use client";

import { useState } from "react";
import { UserPlus } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Skeleton } from "@onecli/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@onecli/ui/components/table";
import { TableCard } from "@/components/table-card";
import { useAuth } from "@/providers/auth-provider";
import type { InvitationRow, OrgMemberListRow } from "@/lib/api";
import { InviteDialog } from "./invite-dialog";
import { MemberRow } from "./member-row";
import { InvitedMemberRow } from "./invited-member-row";

export interface MembersTableProps {
  members: OrgMemberListRow[];
  /**
   * PENDING invitations only — they are people who will be members, so they
   * belong in this table. An `accepted` invitation is already a member row and
   * would duplicate the person; expired/revoked ones are history and live in
   * their own table below.
   */
  invitations: InvitationRow[];
  /**
   * The invitations query is still in flight. It is a SEPARATE query from the
   * members one and reliably the slower of the two (it drains every page and
   * accepted invitations are kept forever), so this table renders before it
   * settles — and must not assert an invited count it doesn't have yet.
   */
  invitationsLoading?: boolean;
  /** Lowercased member email → who invited them (from accepted invitations). */
  invitedBy?: ReadonlyMap<string, string>;
}

/** "1 member" / "3 members" — the count must never read as a plural of one. */
const countLabel = (n: number, noun: string) =>
  `${n} ${n === 1 ? noun : `${noun}s`}`;

export const MembersTable = ({
  members,
  invitations,
  invitationsLoading = false,
  invitedBy,
}: MembersTableProps) => {
  const { user } = useAuth();
  const [inviteOpen, setInviteOpen] = useState(false);

  // "You" is matched by EMAIL, case-insensitively — NOT by `user.id`: the
  // auth context's id is the external auth id (providerAccountId), never the
  // DB userId these rows carry.
  const viewerEmail = user?.email?.toLowerCase();
  const isYou = (row: OrgMemberListRow) =>
    viewerEmail !== undefined && row.email.toLowerCase() === viewerEmail;

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        {/* Deliberately a plain button, not the target's split button: this
            edition has exactly one invite flow (no bulk import, no resend —
            we don't send), so a caret would only re-expose the dialog's own
            role field. */}
        <Button size="sm" onClick={() => setInviteOpen(true)}>
          <UserPlus className="size-3.5" />
          Invite
        </Button>
      </div>
      <TableCard>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead className="w-10">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {/* Two row types share one tbody, so the keys carry a type prefix:
                a future id-format change can't collide across them. */}
            {members.map((member) => (
              <MemberRow
                key={`m-${member.userId}`}
                member={member}
                isYou={isYou(member)}
                invitedBy={invitedBy?.get(member.email.toLowerCase())}
              />
            ))}
            {invitations.map((invitation) => (
              <InvitedMemberRow
                key={`i-${invitation.id}`}
                invitation={invitation}
              />
            ))}
            {/* A placeholder row while invitations load: the alternative is a
                table that silently reads as "nobody is invited" and then grows
                rows under whoever was reading it. */}
            {invitationsLoading && (
              <TableRow className="hover:bg-transparent">
                <TableCell className="py-2.5">
                  <div className="flex items-center gap-3">
                    <Skeleton className="size-7 rounded-full" />
                    <div className="space-y-1.5">
                      <Skeleton className="h-3.5 w-40" />
                      <Skeleton className="h-3 w-56" />
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <Skeleton className="h-3.5 w-14" />
                </TableCell>
                <TableCell />
              </TableRow>
            )}
          </TableBody>
          <TableFooter className="bg-transparent font-normal">
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={3} className="text-muted-foreground text-xs">
                {/* Invited people are NOT members, so they never join the
                    members count — and while the invitations query is in
                    flight the clause is a skeleton rather than a silent zero. */}
                {countLabel(members.length, "member")}
                {invitationsLoading ? (
                  <Skeleton className="ml-2 inline-block h-3 w-20 align-middle" />
                ) : (
                  invitations.length > 0 && ` · ${invitations.length} invited`
                )}
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </TableCard>
      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
    </div>
  );
};
