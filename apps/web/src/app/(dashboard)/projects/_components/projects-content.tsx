"use client";

import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { useProjectsList } from "@/hooks/use-projects";
import { ProjectsEmptyState } from "./projects-empty-state";
import { ProjectsTable } from "./projects-table";

export interface ProjectsContentProps {
  /** Threaded from the RSC page (server-only auth mode); false = local mode. */
  sharingEnabled: boolean;
}

// Ambient scope: `apiFetch` sends the org cookie as `X-Organization-Id`, so
// the selected org's list arrives even while no project is selected — the
// org-with-no-reachable-project state renders the empty state, not an error.
export const ProjectsContent = ({ sharingEnabled }: ProjectsContentProps) => {
  const { data: projects, isPending, isError } = useProjectsList();

  if (isPending) {
    return (
      <div className="space-y-4">
        {[1, 2].map((i) => (
          <Card key={i} className="p-6">
            <div className="flex items-center justify-between">
              <div className="space-y-2">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-4 w-48" />
              </div>
              <Skeleton className="size-8 rounded-md" />
            </div>
          </Card>
        ))}
      </div>
    );
  }

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

  return <ProjectsTable projects={projects} sharingEnabled={sharingEnabled} />;
};
