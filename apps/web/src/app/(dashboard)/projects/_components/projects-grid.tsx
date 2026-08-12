"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { CreateProjectDialog } from "@dashboard/create-project-dialog";
import type { Project } from "@/lib/api";
import { useCurrentProjectId } from "@/hooks/use-projects";
import { useSwitchProject } from "@/hooks/use-switch-project";
import { ProjectCard } from "./project-card";

export interface ProjectsGridProps {
  projects: Project[];
  sharingEnabled: boolean;
}

export const ProjectsGrid = ({
  projects,
  sharingEnabled,
}: ProjectsGridProps) => {
  const [createOpen, setCreateOpen] = useState(false);
  const currentId = useCurrentProjectId();
  const switchTo = useSwitchProject();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="size-3.5" />
          Create project
        </Button>
      </div>
      {/* A real list, not a bare div grid: the table announced its row count
          for free and a grid of divs would silently drop it. Fixed column
          tracks so a lone project keeps a card's width instead of stretching
          across the page.

          `role="list"` is NOT redundant. Tailwind's preflight sets
          `list-style: none` on every `ul`, and WebKit strips the implicit list
          role from an unstyled list — so on Safari/VoiceOver the count this
          markup exists to restore would go unannounced again. */}
      <ul
        role="list"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        {projects.map((project) => (
          <li key={project.id}>
            <ProjectCard
              project={project}
              isCurrent={project.id === currentId}
              sharingEnabled={sharingEnabled}
            />
          </li>
        ))}
      </ul>
      <CreateProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={switchTo}
      />
    </div>
  );
};
