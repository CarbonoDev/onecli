"use client";

import { Card } from "@onecli/ui/components/card";
import { useProjectsList } from "@/hooks/use-projects";
import { ProjectsEmptyState } from "./projects-empty-state";
import { ProjectsGrid } from "./projects-grid";
import { ProjectsSkeleton } from "./projects-skeleton";

export interface ProjectsContentProps {
  /** Threaded from the RSC page (server-only auth mode); false = local mode. */
  sharingEnabled: boolean;
}

// Ambient scope: `apiFetch` sends the org cookie as `X-Organization-Id`, so
// the selected org's list arrives even while no project is selected — the
// org-with-no-reachable-project state renders the empty state, not an error.
export const ProjectsContent = ({ sharingEnabled }: ProjectsContentProps) => {
  const { data: projects, isPending, isError } = useProjectsList();

  if (isPending) return <ProjectsSkeleton />;

  if (isError || !projects) {
    // A plain card: no retry, no toast — the failure is deterministic.
    return (
      <Card className="p-6">
        <p className="text-sm font-medium">Couldn&apos;t load projects</p>
        <p className="text-muted-foreground mt-1 text-xs">
          Something went wrong fetching this organization&apos;s projects.
          Reload the page to try again.
        </p>
      </Card>
    );
  }

  if (projects.length === 0) return <ProjectsEmptyState />;

  return <ProjectsGrid projects={projects} sharingEnabled={sharingEnabled} />;
};
