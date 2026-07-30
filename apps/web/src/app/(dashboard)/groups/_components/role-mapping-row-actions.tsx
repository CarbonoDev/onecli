"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Loader2, MoreHorizontal } from "lucide-react";
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
import { useDeleteRoleMapping } from "@/hooks/use-role-mappings";
import type { GroupRow, RoleMappingRow } from "@/lib/api";
import { RoleMappingDialog } from "./role-mapping-dialog";

export interface RoleMappingRowActionsProps {
  mapping: RoleMappingRow;
  /** Groups selectable when editing — the edit dialog fixes the group, so this
   * only needs to name the current one, but the dialog shares the prop. */
  groups: GroupRow[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** Move this mapping one step higher/lower in priority. Owned by the section
   * (it holds the single reorder mutation over the full ordered set). */
  onMove: (direction: "up" | "down") => void;
  /** A reorder is in flight for the whole list — lock the move controls. */
  reordering: boolean;
}

/**
 * Per-row controls for a role mapping: reorder (priority is first-match, so the
 * order is load-bearing), edit the granted role, and delete. Reordering is
 * lifted to the section so a single `reorder` call carries the whole ordered
 * id set (a partial order 409s server-side).
 */
export const RoleMappingRowActions = ({
  mapping,
  groups,
  canMoveUp,
  canMoveDown,
  onMove,
  reordering,
}: RoleMappingRowActionsProps) => {
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const remove = useDeleteRoleMapping();

  return (
    <div className="flex items-center justify-end gap-1">
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        aria-label="Raise priority"
        disabled={!canMoveUp || reordering}
        onClick={() => onMove("up")}
      >
        <ArrowUp className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        aria-label="Lower priority"
        disabled={!canMoveDown || reordering}
        onClick={() => onMove("down")}
      >
        <ArrowDown className="size-4" />
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="More actions"
            disabled={remove.isPending}
          >
            {remove.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <MoreHorizontal className="size-4" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setEditOpen(true)}>
            Edit role
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setDeleteOpen(true)}
          >
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <RoleMappingDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        availableGroups={groups}
        mapping={mapping}
      />

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete the {mapping.groupName} mapping?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Members of {mapping.groupName} will no longer be raised to{" "}
              {mapping.role} through this mapping. Anyone whose role was granted
              only by it reverts to their base role. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                remove.mutate(mapping.id, {
                  onSuccess: () => setDeleteOpen(false),
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
    </div>
  );
};
