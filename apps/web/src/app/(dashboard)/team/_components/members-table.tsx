"use client";

import { useState } from "react";
import { UserPlus } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Badge } from "@onecli/ui/components/badge";
import { Card } from "@onecli/ui/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@onecli/ui/components/table";
import { useAuth } from "@/providers/auth-provider";
import type { OrgMemberListRow } from "@/lib/api";
import { MemberRowActions } from "./member-row-actions";
import { InviteDialog } from "./invite-dialog";

export interface MembersTableProps {
  members: OrgMemberListRow[];
}

const roleBadgeVariant = (role: string) =>
  role === "owner" ? "default" : role === "admin" ? "secondary" : "outline";

export const MembersTable = ({ members }: MembersTableProps) => {
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
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Members</h2>
        <Button size="sm" onClick={() => setInviteOpen(true)}>
          <UserPlus className="size-3.5" />
          Invite member
        </Button>
      </div>
      <Card className="overflow-hidden p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((row) => (
              <TableRow key={row.userId}>
                <TableCell>
                  <div className="flex flex-col">
                    <span className="font-medium">
                      {row.name ?? row.email}
                      {isYou(row) && (
                        <span className="text-muted-foreground ml-1.5 text-xs">
                          (you)
                        </span>
                      )}
                    </span>
                    {row.name && (
                      <span className="text-muted-foreground text-xs">
                        {row.email}
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={roleBadgeVariant(row.role)}>{row.role}</Badge>
                </TableCell>
                <TableCell>
                  <Badge
                    variant={
                      row.status === "suspended" ? "destructive" : "outline"
                    }
                  >
                    {row.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {new Date(row.joinedAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </TableCell>
                <TableCell>
                  <MemberRowActions member={row} isYou={isYou(row)} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
    </div>
  );
};
