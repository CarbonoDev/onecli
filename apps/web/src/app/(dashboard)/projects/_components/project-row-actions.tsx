"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { ApiError, type Project } from "@/lib/api";
import { ProjectAccessDialog } from "@/components/project-access-dialog";
import {
  useCurrentProjectId,
  useDeleteProject,
  useRenameProject,
} from "@/hooks/use-projects";
import { useProjectAccess } from "@/hooks/use-project-access";
import { useSwitchProject } from "@/hooks/use-switch-project";
import {
  clearDefaultProjectCookie,
  readDefaultProjectCookie,
} from "@/lib/navigation";

export interface ProjectRowActionsProps {
  project: Project;
  sharingEnabled: boolean;
}

/**
 * `Project.name` is nullable (legacy `accounts` rows carry NULL), and those
 * neglected projects are exactly the ones an admin wants gone — so the
 * type-to-confirm gate falls back to a fixed literal instead of an empty string
 * nobody can type.
 */
const FALLBACK_CONFIRMATION = "delete";

export const ProjectRowActions = ({
  project,
  sharingEnabled,
}: ProjectRowActionsProps) => {
  const router = useRouter();
  const queryClient = useQueryClient();
  const switchTo = useSwitchProject();
  const currentId = useCurrentProjectId();
  const isCurrent = project.id === currentId;

  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [name, setName] = useState(project.name ?? "");
  const [confirmation, setConfirmation] = useState("");
  // The server's 409 refusal (last project / a member would be stranded),
  // rendered inline in the open delete dialog — verbatim and specific.
  const [deleteRefusal, setDeleteRefusal] = useState<string | null>(null);
  const rename = useRenameProject();
  const remove = useDeleteProject();

  // The access query is lazy: nothing fetches until the action is chosen, and
  // the dialog renders only once bindings load — its documented contract (a
  // replace-set picker seeded from a failed read could wipe bindings on Save).
  const [accessRequested, setAccessRequested] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const access = useProjectAccess(
    project.id,
    sharingEnabled && accessRequested,
  );

  const trimmed = name.trim();
  // Mirrors `projectNameSchema` (1-100 after trim, deliberately non-unique).
  const nameError =
    trimmed.length === 0
      ? "Name is required."
      : trimmed.length > 100
        ? "Name must be 100 characters or fewer."
        : null;

  const displayName = project.name?.trim() ?? "";
  const expected = displayName || FALLBACK_CONFIRMATION;
  // Client-side only: `apiDelete` sends no body, so this is friction, not a
  // check. The server's refusals are the real guards.
  const confirmed = confirmation.trim() === expected;

  const handleRenameOpen = (open: boolean) => {
    if (open) setName(project.name ?? "");
    setRenameOpen(open);
  };

  const handleRename = () => {
    if (nameError || rename.isPending) return;
    rename.mutate(
      { id: project.id, name: trimmed },
      { onSuccess: () => setRenameOpen(false) },
    );
  };

  const handleDeleteOpen = (open: boolean) => {
    if (open) {
      setConfirmation("");
      setDeleteRefusal(null);
    }
    setDeleteOpen(open);
  };

  const handleDelete = () => {
    if (!confirmed || remove.isPending) return;
    setDeleteRefusal(null);
    remove.mutate(project.id, {
      // The dialog closes ONLY on success — a refusal keeps it open with the
      // server's reason inline.
      onSuccess: () => {
        setDeleteOpen(false);
        toast.success("Project deleted");
        if (readDefaultProjectCookie() === project.id) {
          // The selection just became dangling; clear it and let the server
          // re-resolve a default on the refresh. Stay on /projects.
          clearDefaultProjectCookie();
          queryClient.clear();
          router.refresh();
        }
      },
      onError: (err) => {
        if (err instanceof ApiError && err.status === 409) {
          setDeleteRefusal(err.message);
        }
      },
    });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
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
          <DropdownMenuItem
            disabled={isCurrent}
            onClick={() => switchTo(project.id)}
          >
            Switch to this project
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleRenameOpen(true)}>
            Rename
          </DropdownMenuItem>
          {sharingEnabled && (
            <DropdownMenuItem
              onClick={() => {
                setAccessRequested(true);
                setAccessOpen(true);
              }}
            >
              Manage access
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => handleDeleteOpen(true)}
          >
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={renameOpen} onOpenChange={handleRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename {displayName || "this project"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor={`rename-project-${project.id}`}>Name</Label>
            <Input
              id={`rename-project-${project.id}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRename();
              }}
              autoFocus
            />
            {nameError && name !== (project.name ?? "") && (
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

      {sharingEnabled && access.data && (
        <ProjectAccessDialog
          projectId={project.id}
          current={access.data}
          open={accessOpen}
          onOpenChange={setAccessOpen}
        />
      )}

      {/* AlertDialog, not Dialog: the app's convention for every destructive
          confirm. Type-to-confirm as on the settings page. */}
      <AlertDialog open={deleteOpen} onOpenChange={handleDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {displayName || "this project"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the project&apos;s agents, API keys, secrets, app
              connections and policy rules. Anyone who relies on this project
              loses access to it. Activity history is kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor={`delete-project-confirm-${project.id}`}>
              Type <span className="font-medium">{expected}</span> to confirm
            </Label>
            <Input
              id={`delete-project-confirm-${project.id}`}
              value={confirmation}
              autoComplete="off"
              onChange={(e) => setConfirmation(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleDelete();
              }}
            />
            {deleteRefusal && (
              <p className="text-destructive text-xs">{deleteRefusal}</p>
            )}
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
