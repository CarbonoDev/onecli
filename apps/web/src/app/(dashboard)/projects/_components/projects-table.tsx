"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Badge } from "@onecli/ui/components/badge";
import { Card } from "@onecli/ui/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@onecli/ui/components/table";
import { CreateProjectDialog } from "@dashboard/create-project-dialog";
import type { Project } from "@/lib/api";
import { useCurrentProjectId } from "@/hooks/use-projects";
import { useSwitchProject } from "@/hooks/use-switch-project";
import { ProjectRowActions } from "./project-row-actions";

export interface ProjectsTableProps {
  projects: Project[];
  sharingEnabled: boolean;
}

export const ProjectsTable = ({
  projects,
  sharingEnabled,
}: ProjectsTableProps) => {
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
      <Card className="overflow-hidden p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {projects.map((project) => {
              // The switcher's fallback chain — legacy rows carry NULL names,
              // and some also a NULL slug.
              const label = project.name ?? project.slug ?? project.id;
              return (
                <TableRow
                  key={project.id}
                  // The whole row enters the project: this table is the org
                  // shell's only way into project scope, so the affordance has
                  // to be the thing people reach for. The name below is the
                  // real control (focusable, announced); this just widens its
                  // hit area for the mouse.
                  onClick={() => switchTo(project.id)}
                  className="hover:bg-muted/50 cursor-pointer"
                >
                  <TableCell>
                    <button
                      type="button"
                      // Stop the row handler from firing a second switch.
                      onClick={(e) => {
                        e.stopPropagation();
                        switchTo(project.id);
                      }}
                      // Explicit `cursor-pointer`: Tailwind's preflight gives
                      // buttons `cursor: default`, which would disagree with
                      // the row it sits in.
                      className="cursor-pointer font-medium hover:underline"
                    >
                      {label}
                    </button>
                    {project.name && project.slug && (
                      <span className="text-muted-foreground ml-2 text-xs">
                        {project.slug}
                      </span>
                    )}
                    {project.id === currentId && (
                      <Badge variant="secondary" className="ml-2 text-xs">
                        Current
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(project.createdAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </TableCell>
                  {/* The kebab and everything it opens must not also enter the
                      project. Menu content and dialogs render in portals, so
                      only the trigger bubbles through the row — but Rename and
                      Delete would be unusable if it did. */}
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <ProjectRowActions
                      project={project}
                      sharingEnabled={sharingEnabled}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>
      <CreateProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={switchTo}
      />
    </div>
  );
};
