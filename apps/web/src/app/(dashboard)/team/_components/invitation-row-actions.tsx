"use client";

import { useState } from "react";
import { Loader2, X } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
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
import { useRevokeInvitation } from "@/hooks/use-invitations";
import type { InvitationRow } from "@/lib/api";
import { CopyLinkButton } from "./copy-link-button";

export interface InvitationRowActionsProps {
  invitation: InvitationRow;
}

/**
 * Row actions for a pending invitation: copy the join link, then revoke.
 *
 * The copy button is NOT decoration and must not be dropped to match a
 * screenshot of a product that mails its invites: OneCLI open edition sends no
 * email (see `invite-dialog.tsx`), so the admin hand-delivers the link. Without
 * a copy affordance on the row, closing the creation dialog loses the only copy
 * of the link and the invitation is dead.
 */
export const InvitationRowActions = ({
  invitation,
}: InvitationRowActionsProps) => {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const revoke = useRevokeInvitation();

  const handleRevoke = () =>
    revoke.mutate(invitation.id, {
      onSuccess: () => setConfirmOpen(false),
    });

  return (
    <div className="flex items-center justify-end gap-1">
      <CopyLinkButton
        token={invitation.token}
        label={`Copy the invite link for ${invitation.email}`}
      />
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        title="Revoke invitation"
        // The icon is a bare `×`; destructive actions need the target named.
        aria-label={`Revoke the invitation for ${invitation.email}`}
        onClick={() => setConfirmOpen(true)}
        disabled={revoke.isPending}
      >
        {revoke.isPending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <X className="size-4" />
        )}
      </Button>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Revoke the invitation for {invitation.email}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The join link stops working immediately. You can invite this
              address again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoke.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleRevoke();
              }}
              disabled={revoke.isPending}
            >
              {revoke.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Revoking...
                </>
              ) : (
                "Revoke"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
