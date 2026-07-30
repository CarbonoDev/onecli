"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
import type { Project } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { useRenameProject } from "@/hooks/use-projects";

export interface ProjectNameCardProps {
  project: Project;
  canManage: boolean;
}

export const ProjectNameCard = ({
  project,
  canManage,
}: ProjectNameCardProps) => {
  const [name, setName] = useState(project.name ?? "");
  const rename = useRenameProject();
  const qc = useQueryClient();

  const trimmed = name.trim();
  const error =
    trimmed.length === 0
      ? "Name is required."
      : trimmed.length > 100
        ? "Name must be 100 characters or fewer."
        : null;
  const dirty = trimmed !== (project.name ?? "");

  const handleSave = () => {
    if (error || !dirty || rename.isPending) return;
    rename.mutate(
      { id: project.id, name: trimmed },
      {
        onSuccess: () => {
          // The rename hook deliberately owns no cache, so the invalidation
          // lives with the component that knows which query it fed.
          qc.invalidateQueries({
            queryKey: queryKeys.projects.detail(project.id),
          });
          toast.success("Project renamed");
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Name</CardTitle>
        <CardDescription>
          How this project appears across the dashboard. Names do not have to be
          unique.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="max-w-sm space-y-2">
          <Label htmlFor="project-name">Project name</Label>
          <Input
            id="project-name"
            value={name}
            disabled={!canManage}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave();
            }}
          />
          {error && dirty && (
            <p className="text-destructive text-xs">{error}</p>
          )}
        </div>
        <Button
          onClick={handleSave}
          loading={rename.isPending}
          disabled={!canManage || !dirty || error !== null || rename.isPending}
        >
          {rename.isPending ? "Saving..." : "Save"}
        </Button>
      </CardContent>
    </Card>
  );
};
