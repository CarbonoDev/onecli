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
import { useCreateProject } from "@/hooks/use-projects";

export interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the new project's id once the create succeeds, so the caller
   * can switch to it. */
  onCreated?: (projectId: string) => void;
}

export const CreateProjectDialog = ({
  open,
  onOpenChange,
  onCreated,
}: CreateProjectDialogProps) => {
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const createProject = useCreateProject();

  const trimmed = name.trim();
  // Mirrors `projectNameSchema` (1-100 after trim). Names are deliberately NOT
  // unique per org, so there is no duplicate check here — two projects may
  // share a name and the API disambiguates their slugs silently.
  const nameError =
    trimmed.length === 0
      ? "Name is required."
      : trimmed.length > 100
        ? "Name must be 100 characters or fewer."
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
    if (nameError || createProject.isPending) return;
    createProject.mutate(trimmed, {
      onSuccess: (project) => {
        handleClose(false);
        onCreated?.(project.id);
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create project</DialogTitle>
          <DialogDescription>
            A project holds its own agents, credentials and policy. You will be
            its owner.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label htmlFor="project-name">Name</Label>
          <Input
            id="project-name"
            placeholder="e.g. Production"
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
            loading={createProject.isPending}
            disabled={createProject.isPending}
          >
            {createProject.isPending ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
