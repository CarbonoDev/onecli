"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import { Button } from "@onecli/ui/components/button";
import { Label } from "@onecli/ui/components/label";
import {
  useCreateRoleMapping,
  useUpdateRoleMapping,
  useRoleMappingPreview,
} from "@/hooks/use-role-mappings";
import type { GroupRow, RoleMappingRow } from "@/lib/api";

export interface RoleMappingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Groups selectable for a NEW mapping — the ones without a mapping already
   * (a group maps to at most one role). Ignored when editing. */
  availableGroups: GroupRow[];
  /** Present = edit an existing mapping (group is fixed, only the role changes);
   * absent = create. */
  mapping?: RoleMappingRow;
}

type Role = "admin" | "member";

/**
 * Create or edit a group→role mapping. On create the admin picks a group and a
 * role; on edit the group is fixed (a mapping's group is its identity — only
 * the granted role is editable) and the select is disabled.
 *
 * The live preview is the honest part: it asks the server how many members
 * WOULD change role under the proposed mapping before it is written, so an
 * admin sees the blast radius (a raise-only change, but still a change) up
 * front rather than from a surprised teammate.
 */
export const RoleMappingDialog = ({
  open,
  onOpenChange,
  availableGroups,
  mapping,
}: RoleMappingDialogProps) => {
  const isEdit = mapping !== undefined;
  const [groupId, setGroupId] = useState(mapping?.groupId ?? "");
  const [role, setRole] = useState<Role>(mapping?.role ?? "member");

  const create = useCreateRoleMapping();
  const update = useUpdateRoleMapping();
  const pending = create.isPending || update.isPending;

  // Reset the form whenever the dialog (re)opens — a create after an edit must
  // not inherit the edited mapping's group/role.
  useEffect(() => {
    if (open) {
      setGroupId(mapping?.groupId ?? "");
      setRole(mapping?.role ?? "member");
    }
  }, [open, mapping]);

  // Only preview once a group is chosen — the hook already no-ops on an empty
  // groupId, but this keeps the query key stable.
  const previewInput = useMemo(
    () => (groupId ? { groupId, role } : null),
    [groupId, role],
  );
  const preview = useRoleMappingPreview(previewInput);

  const handleSubmit = () => {
    if (!groupId || pending) return;
    if (isEdit) {
      update.mutate(
        { id: mapping.id, input: { role } },
        { onSuccess: () => onOpenChange(false) },
      );
    } else {
      create.mutate(
        { groupId, role },
        { onSuccess: () => onOpenChange(false) },
      );
    }
  };

  const affected = preview.data?.affectedCount ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit role mapping" : "Add role mapping"}
          </DialogTitle>
          <DialogDescription>
            Members of the group are granted at least this role. Mappings only
            raise a member&apos;s role — they never lower it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="role-mapping-group">Group</Label>
            <Select
              value={groupId}
              onValueChange={setGroupId}
              disabled={isEdit}
            >
              <SelectTrigger id="role-mapping-group">
                <SelectValue placeholder="Select a group" />
              </SelectTrigger>
              <SelectContent>
                {isEdit ? (
                  <SelectItem value={mapping.groupId}>
                    {mapping.groupName}
                  </SelectItem>
                ) : availableGroups.length === 0 ? (
                  <div className="text-muted-foreground px-2 py-1.5 text-xs">
                    Every group already has a mapping.
                  </div>
                ) : (
                  availableGroups.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="role-mapping-role">Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger id="role-mapping-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">Member</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <p
            className="text-muted-foreground text-xs"
            role="status"
            aria-live="polite"
          >
            {!groupId
              ? "Select a group to preview the impact."
              : preview.isPending
                ? "Checking impact…"
                : preview.isError
                  ? "Couldn't preview the impact."
                  : affected === 0
                    ? "No members would change role."
                    : `${affected} member${affected === 1 ? "" : "s"} would be raised to ${role}.`}
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            loading={pending}
            disabled={!groupId || pending}
          >
            {pending
              ? isEdit
                ? "Saving..."
                : "Adding..."
              : isEdit
                ? "Save"
                : "Add mapping"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
