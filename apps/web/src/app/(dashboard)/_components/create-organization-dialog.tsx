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
import type { CreatedOrganization } from "@/lib/api";
import { useCreateOrganization } from "@/hooks/use-organizations";

export interface CreateOrganizationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the new org once the create succeeds, so the caller can
   * switch to it — id AND the default project it was born with. */
  onCreated?: (organization: CreatedOrganization) => void;
}

export const CreateOrganizationDialog = ({
  open,
  onOpenChange,
  onCreated,
}: CreateOrganizationDialogProps) => {
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const createOrganization = useCreateOrganization();

  const trimmed = name.trim();
  // Mirrors `orgNameSchema` (1-255 after trim). Names are deliberately NOT
  // unique across orgs — the slug is what stays unique, and the server derives
  // it — so there is no duplicate check here.
  const nameError =
    trimmed.length === 0
      ? "Name is required."
      : trimmed.length > 255
        ? "Name must be 255 characters or fewer."
        : null;
  const showNameError = touched && nameError !== null;

  const handleClose = (value: boolean) => {
    if (!value) {
      setName("");
      setTouched(false);
    }
    onOpenChange(value);
  };

  const handleCreate = () => {
    setTouched(true);
    if (nameError || createOrganization.isPending) return;
    createOrganization.mutate(trimmed, {
      onSuccess: (organization) => {
        handleClose(false);
        onCreated?.(organization);
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create organization</DialogTitle>
          <DialogDescription>
            An organization has its own members, projects and policy. You will
            be its owner, and it starts with a default project.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label htmlFor="organization-name">Name</Label>
          <Input
            id="organization-name"
            placeholder="e.g. Acme"
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
            loading={createOrganization.isPending}
            disabled={createOrganization.isPending}
          >
            {createOrganization.isPending ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
