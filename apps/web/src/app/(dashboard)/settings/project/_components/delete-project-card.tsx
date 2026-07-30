"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
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
import type { Project } from "@/lib/api";
import { useDeleteProject } from "@/hooks/use-projects";

export interface DeleteProjectCardProps {
  project: Project;
  canManage: boolean;
}

/**
 * `Project.name` is nullable (legacy `accounts` rows carry NULL), and those
 * neglected projects are exactly the ones an admin wants gone — so the
 * type-to-confirm gate falls back to a fixed literal instead of an empty string
 * nobody can type.
 */
const FALLBACK_CONFIRMATION = "delete";

export const DeleteProjectCard = ({
  project,
  canManage,
}: DeleteProjectCardProps) => {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const remove = useDeleteProject();
  const router = useRouter();

  const name = project.name?.trim() ?? "";
  const expected = name || FALLBACK_CONFIRMATION;
  // Client-side only: `apiDelete` sends no body, so this is friction, not a
  // check. The server's refusals (last project in the org, a member who would
  // be left with none) are the real guards and their messages are toasted
  // verbatim by the hook.
  const confirmed = confirmation.trim() === expected;

  const handleOpenChange = (next: boolean) => {
    if (next) setConfirmation("");
    setOpen(next);
  };

  const handleDelete = () => {
    if (!confirmed || remove.isPending) return;
    remove.mutate(project.id, {
      onSuccess: () => {
        setOpen(false);
        toast.success("Project deleted");
        // The next request re-resolves a different default project.
        router.replace("/overview");
      },
    });
  };

  return (
    <>
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle>Delete this project</CardTitle>
          <CardDescription>
            Agents, API keys, secrets, connections and policy rules in this
            project are deleted permanently. Activity history is kept. This
            cannot be undone.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="destructive"
            disabled={!canManage}
            onClick={() => handleOpenChange(true)}
          >
            Delete project
          </Button>
        </CardContent>
      </Card>

      {/* AlertDialog, not Dialog: the app's convention for every destructive
          confirm (group + member row actions, connections, secrets, keys). */}
      <AlertDialog open={open} onOpenChange={handleOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {name || "this project"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the project&apos;s agents, API keys, secrets, app
              connections and policy rules. Anyone who relies on this project
              loses access to it. Activity history is kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="delete-project-confirm">
              Type <span className="font-medium">{expected}</span> to confirm
            </Label>
            <Input
              id="delete-project-confirm"
              value={confirmation}
              autoComplete="off"
              onChange={(e) => setConfirmation(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleDelete();
              }}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>
              Cancel
            </AlertDialogCancel>
            {/* preventDefault + manual mutate keeps the dialog open while the
                request is in flight (the group-row-actions pattern). */}
            <AlertDialogAction
              variant="destructive"
              onClick={(e) => {
                e.preventDefault();
                handleDelete();
              }}
              disabled={!confirmed || remove.isPending}
            >
              {remove.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete project"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
