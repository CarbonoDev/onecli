"use client";

import { useState } from "react";
import { UserPlus } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
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
import type {
  InvitationRow as InvitationRowData,
  OrgMemberListRow,
} from "@/lib/api";
import { InviteDialog } from "./invite-dialog";
import { MemberRow } from "./member-row";
import { InvitationRow } from "./invitation-row";

export interface MembersTableProps {
  members: OrgMemberListRow[];
  /**
   * PENDING invitations only — they are people who will be members, so they
   * belong in this table. An `accepted` invitation is already a member row and
   * would duplicate the person; expired/revoked ones are history and live in
   * their own table below.
   */
  invitations: InvitationRowData[];
}

/** "1 member" / "3 members" — the count must never read as a plural of one. */
const countLabel = (n: number, noun: string) =>
  `${n} ${n === 1 ? noun : `${noun}s`}`;

export const MembersTable = ({ members, invitations }: MembersTableProps) => {
  const { user } = useAuth();
  const [inviteOpen, setInviteOpen] = useState(false);

  // "You" is matched by EMAIL, case-insensitively — NOT by `user.id`: the
  // auth context's id is the external auth id (providerAccountId), never the
  // DB userId these rows carry.
  const viewerEmail = user?.email?.toLowerCase();
  const isYou = (row: OrgMemberListRow) =>
    viewerEmail !== undefined && row.email.toLowerCase() === viewerEmail;

  // Invited people are NOT members yet, so they are never folded into the
  // members count — they get their own clause or none at all.
  const summary =
    invitations.length > 0
      ? `${countLabel(members.length, "member")} · ${invitations.length} invited`
      : countLabel(members.length, "member");

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
            {members.length === 0 && invitations.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={3}
                  className="text-muted-foreground py-8 text-center"
                >
                  No members yet.
                </TableCell>
              </TableRow>
            )}
            {/* Two row types share one tbody, so the keys carry a type prefix:
                a future id-format change can't collide across them. */}
            {members.map((member) => (
              <MemberRow
                key={`m-${member.userId}`}
                member={member}
                isYou={isYou(member)}
              />
            ))}
            {invitations.map((invitation) => (
              <InvitationRow
                key={`i-${invitation.id}`}
                invitation={invitation}
              />
            ))}
          </TableBody>
          <TableFooter className="bg-transparent font-normal">
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={3} className="text-muted-foreground text-xs">
                {summary}
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </TableCard>
      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
    </div>
  );
};
