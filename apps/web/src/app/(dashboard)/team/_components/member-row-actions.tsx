"use client";

import { useState } from "react";
import { MoreHorizontal, Loader2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@onecli/ui/components/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { useUpdateOrgMember } from "@/hooks/use-org-members";
import type { OrgMemberListRow } from "@/lib/api";

export interface MemberRowActionsProps {
  member: OrgMemberListRow;
  isYou: boolean;
}

export const MemberRowActions = ({ member, isYou }: MemberRowActionsProps) => {
  const [suspendOpen, setSuspendOpen] = useState(false);
  const update = useUpdateOrgMember();

  // Owners are untouchable through this surface, and the API rejects every
  // self-change (self-suspend would lock the admin out of the undo surface).
  const locked = isYou || member.role === "owner";
  const suspended = member.status === "suspended";

  const setRole = (role: "admin" | "member") =>
    update.mutate({ userId: member.userId, input: { role } });

  const handleSuspend = () =>
    update.mutate(
      { userId: member.userId, input: { status: "suspended" } },
      { onSuccess: () => setSuspendOpen(false) },
    );

  const handleReinstate = () =>
    update.mutate({ userId: member.userId, input: { status: "active" } });

  if (locked) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* span wrapper: disabled buttons swallow the hover events the
              tooltip needs */}
          <span className="inline-flex">
            <Button variant="ghost" size="icon" className="size-8" disabled>
              <MoreHorizontal className="size-4" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {isYou
            ? "You cannot change your own membership."
            : "The organization owner cannot be changed here."}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            disabled={update.isPending}
          >
            {update.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <MoreHorizontal className="size-4" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {member.role === "member" ? (
            <DropdownMenuItem onClick={() => setRole("admin")}>
              Make admin
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={() => setRole("member")}>
              Make member
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          {suspended ? (
            <DropdownMenuItem onClick={handleReinstate}>
              Reinstate
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              variant="destructive"
              onClick={() => setSuspendOpen(true)}
            >
              Suspend
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={suspendOpen} onOpenChange={setSuspendOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Suspend {member.email}?</AlertDialogTitle>
            <AlertDialogDescription>
              A suspended member loses all access immediately — every
              authorization check treats them as a non-member until they are
              reinstated.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={update.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleSuspend();
              }}
              disabled={update.isPending}
            >
              {update.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Suspending...
                </>
              ) : (
                "Suspend"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
