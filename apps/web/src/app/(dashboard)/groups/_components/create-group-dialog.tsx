"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { cn } from "@onecli/ui/lib/utils";
import { useCreateGroup } from "@/hooks/use-groups";

export interface CreateGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const CreateGroupDialog = ({
  open,
  onOpenChange,
}: CreateGroupDialogProps) => {
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const createGroup = useCreateGroup();

  const trimmed = name.trim();
  const nameError =
    trimmed.length === 0
      ? "Name is required."
      : trimmed.length > 100
        ? "Name must be 100 characters or fewer."
        : null;
  const showNameError = touched && nameError !== null;

  const handleCreate = () => {
    setTouched(true);
    if (nameError || createGroup.isPending) return;
    createGroup.mutate(trimmed, { onSuccess: () => handleClose(false) });
  };

  const handleClose = (value: boolean) => {
    if (!value) {
      setName("");
      setTouched(false);
    }
    onOpenChange(value);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create group</DialogTitle>
          <DialogDescription>
            Groups organize members for project access and policy rules.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label htmlFor="group-name">Name</Label>
          <Input
            id="group-name"
            placeholder="e.g. Engineering"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setTouched(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
            }}
            autoFocus
            className={cn(showNameError && "border-destructive")}
          />
          {showNameError && (
            <p className="text-destructive text-xs">{nameError}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => handleClose(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            loading={createGroup.isPending}
            disabled={createGroup.isPending}
          >
            {createGroup.isPending ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
