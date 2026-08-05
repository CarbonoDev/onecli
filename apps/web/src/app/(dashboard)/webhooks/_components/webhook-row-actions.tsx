"use client";

import { useState } from "react";
import { Loader2, MoreHorizontal } from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import { useDeleteWebhook, useRotateWebhookSecret } from "@/hooks/use-webhooks";
import type { WebhookEndpoint } from "@/lib/api";
import { EditWebhookDialog } from "./edit-webhook-dialog";

export interface WebhookRowActionsProps {
  endpoint: WebhookEndpoint;
  /** Set when the row's own page is being deleted, so it can navigate away. */
  onDeleted?: () => void;
}

export const WebhookRowActions = ({
  endpoint,
  onDeleted,
}: WebhookRowActionsProps) => {
  const [editOpen, setEditOpen] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const rotate = useRotateWebhookSecret();
  const remove = useDeleteWebhook();
  const busy = rotate.isPending || remove.isPending;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <MoreHorizontal className="size-4" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setEditOpen(true)}>
            Edit
          </DropdownMenuItem>
          {endpoint.hasSecret && (
            <DropdownMenuItem onClick={() => setRotateOpen(true)}>
              Rotate secret
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setDeleteOpen(true)}
          >
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <EditWebhookDialog
        endpoint={endpoint}
        open={editOpen}
        onOpenChange={setEditOpen}
      />

      <AlertDialog open={rotateOpen} onOpenChange={setRotateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate the secret?</AlertDialogTitle>
            <AlertDialogDescription>
              {/* The gap between rotating here and updating the provider is a
                  window of rejected deliveries — say so before, not after. */}
              Deliveries signed with the old secret are rejected the moment this
              completes. Have the provider&apos;s settings page open and ready
              to paste the new one.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rotate.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                rotate.mutate(endpoint.id, {
                  onSuccess: () => setRotateOpen(false),
                });
              }}
              disabled={rotate.isPending}
            >
              {rotate.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Rotating...
                </>
              ) : (
                "Rotate"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {endpoint.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The URL stops accepting deliveries immediately and its entire
              delivery history is removed. Any sender still posting to it will
              start seeing 404s. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                remove.mutate(endpoint.id, {
                  onSuccess: () => {
                    setDeleteOpen(false);
                    onDeleted?.();
                  },
                });
              }}
              disabled={remove.isPending}
            >
              {remove.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
