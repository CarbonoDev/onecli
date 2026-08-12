"use client";

import { useState } from "react";
import { FolderKanban, Plus } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { CreateProjectDialog } from "@dashboard/create-project-dialog";
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
      <Card className="flex flex-col items-center justify-center py-12 text-center">
        <div className="bg-muted mb-4 flex size-12 items-center justify-center rounded-full">
          <FolderKanban className="text-muted-foreground size-6" />
        </div>
        {/* Binding-accurate, not inventory-claiming: the org may well have
            projects this caller simply cannot reach. */}
        <p className="text-sm font-medium">No projects to show</p>
        <p className="text-muted-foreground mt-1 max-w-xs text-xs">
          You don&apos;t have access to any projects in this organization yet.
          Create one to get started.
        </p>
        <Button size="sm" className="mt-4" onClick={() => setCreateOpen(true)}>
          <Plus className="size-3.5" />
          Create project
        </Button>
      </Card>

      <CreateProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={switchTo}
      />
    </>
  );
};
