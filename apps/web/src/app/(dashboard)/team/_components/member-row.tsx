"use client";

import { Badge } from "@onecli/ui/components/badge";
import { TableCell, TableRow } from "@onecli/ui/components/table";
import type { OrgMemberListRow } from "@/lib/api";
import { MemberAvatar } from "./member-avatar";
import { MemberRowActions } from "./member-row-actions";

export interface MemberRowProps {
  member: OrgMemberListRow;
  isYou: boolean;
}

const formatJoined = (joinedAt: string) =>
  new Date(joinedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

/**
 * One joined member. The trailing action is the kebab, never an `×`: the API
 * has no member-removal route (`/v1/org/members` is GET + PATCH), and the only
 * destructive thing it can do is suspend — which is not removal and must not
 * be dressed up as it.
 */
export const MemberRow = ({ member, isYou }: MemberRowProps) => {
  const suspended = member.status === "suspended";
  // The email only needs its own line when the first line shows a name.
  const details = [
    member.name ? member.email : null,
    `Joined ${formatJoined(member.joinedAt)}`,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <TableRow>
      <TableCell className="py-2.5">
        <div className="flex items-center gap-3">
          <MemberAvatar name={member.name} email={member.email} />
          <div className="flex min-w-0 flex-col">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-medium">
                {member.name ?? member.email}
              </span>
              {isYou && (
                <Badge
                  variant="secondary"
                  className="px-1.5 py-0 text-[10px] tracking-wider uppercase"
                >
                  You
                </Badge>
              )}
              {/* Suspension is an authorization state, not decoration: the
                  target has no Status column, so a suspended member says so
                  here rather than disappearing into an ordinary row. */}
              {suspended && (
                <Badge
                  variant="outline"
                  className="border-destructive/40 text-destructive px-1.5 py-0 text-[10px] tracking-wider uppercase"
                >
                  Suspended
                </Badge>
              )}
            </div>
            <span className="text-muted-foreground truncate text-xs">
              {details}
            </span>
          </div>
        </div>
      </TableCell>
      <TableCell className="capitalize">{member.role}</TableCell>
      <TableCell className="text-right">
        <MemberRowActions member={member} isYou={isYou} />
      </TableCell>
    </TableRow>
  );
};
