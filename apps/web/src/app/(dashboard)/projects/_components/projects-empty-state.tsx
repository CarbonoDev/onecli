"use client";

import { useState } from "react";
import { FolderKanban, Plus } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { CreateProjectDialog } from "@dashboard/create-project-dialog";
import { EmptyState } from "@/components/empty-state";
import { useSwitchProject } from "@/hooks/use-switch-project";

/**
 * Where "this org, no project yet" (#31) lands — including the Get Started
 * picker's `/org/<id>/projects` link on flat editions. Creating from here
 * switches to the new project, so the rest of the dashboard scopes to it.
 */
export const ProjectsEmptyState = () => {
  const [createOpen, setCreateOpen] = useState(false);
  const switchTo = useSwitchProject();

  return (
    <>
      <EmptyState
        variant="card"
        icon={FolderKanban}
        // The `title` escape hatch, not `things`: `No projects yet` would
        // claim an inventory this page cannot see. Binding-accurate — the org
        // may well have projects this caller simply cannot reach.
        title="No projects to show"
        description="You don't have access to any projects in this organization yet. Create one to get started."
        action={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5" />
            Create project
          </Button>
        }
      />

      <CreateProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={switchTo}
      />
    </>
  );
};
