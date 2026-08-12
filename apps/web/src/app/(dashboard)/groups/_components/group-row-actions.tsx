"use client";

import { useState } from "react";
import { MoreHorizontal, Loader2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
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
import { useRenameGroup, useDeleteGroup } from "@/hooks/use-groups";
import type { GroupRow } from "@/lib/api";
import { GroupMembersDialog } from "./group-members-dialog";

export interface GroupRowActionsProps {
  group: GroupRow;
}

export const GroupRowActions = ({ group }: GroupRowActionsProps) => {
  const [renameOpen, setRenameOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [name, setName] = useState(group.name);
  const rename = useRenameGroup();
  const remove = useDeleteGroup();
  // SCIM-sourced rows (possible after an EE-to-OSS migration) are read-only:
  // every mutation deterministically 409s server-side, so offering the
  // actions would only surface error toasts.
  const isManual = group.source === "manual";

  const trimmed = name.trim();
  const nameError =
    trimmed.length === 0
      ? "Name is required."
      : trimmed.length > 100
        ? "Name must be 100 characters or fewer."
        : null;

  const handleRenameOpen = (open: boolean) => {
    if (open) setName(group.name);
    setRenameOpen(open);
  };

  const handleRename = () => {
    if (nameError || rename.isPending) return;
    rename.mutate(
      { groupId: group.id, name: trimmed },
      { onSuccess: () => setRenameOpen(false) },
    );
  };

  const handleDelete = () => {
    remove.mutate(group.id, { onSuccess: () => setDeleteOpen(false) });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={`Actions for ${group.name}`}
            disabled={rename.isPending || remove.isPending}
          >
            {rename.isPending || remove.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <MoreHorizontal className="size-4" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {!isManual && (
            <DropdownMenuLabel className="text-muted-foreground max-w-48 text-xs font-normal">
              Managed by your identity provider
            </DropdownMenuLabel>
          )}
          <DropdownMenuItem
            disabled={!isManual}
            onClick={() => handleRenameOpen(true)}
          >
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!isManual}
            onClick={() => setMembersOpen(true)}
          >
            Manage members
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={!isManual}
            onClick={() => setDeleteOpen(true)}
          >
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={renameOpen} onOpenChange={handleRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename {group.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor={`rename-group-${group.id}`}>Name</Label>
            <Input
              id={`rename-group-${group.id}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRename();
              }}
              autoFocus
            />
            {nameError && name !== group.name && (
              <p className="text-destructive text-xs">{nameError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => handleRenameOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleRename}
              loading={rename.isPending}
              disabled={nameError !== null || rename.isPending}
            >
              {rename.isPending ? "Renaming..." : "Rename"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <GroupMembersDialog
        groupId={group.id}
        groupName={group.name}
        open={membersOpen}
        onOpenChange={setMembersOpen}
      />

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {group.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {/* The impact counts matter: the project-access cascade is a
                  silent access revocation. */}
              This removes the group and its {group.memberCount} membership
              {group.memberCount === 1 ? "" : "s"}. Any project access granted
              through this group is revoked immediately. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleDelete();
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
