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
            {projects.map((project) => (
              <TableRow key={project.id}>
                <TableCell>
                  {/* The switcher's fallback chain — legacy rows carry NULL
                      names, and some also a NULL slug. */}
                  <span className="font-medium">
                    {project.name ?? project.slug ?? project.id}
                  </span>
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
                <TableCell>
                  <ProjectRowActions
                    project={project}
                    sharingEnabled={sharingEnabled}
                  />
                </TableCell>
              </TableRow>
            ))}
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
