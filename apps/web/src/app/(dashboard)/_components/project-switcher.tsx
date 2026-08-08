"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronsUpDown, FolderOpen, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@onecli/ui/components/sidebar";
import { cn } from "@onecli/ui/lib/utils";
import { useCurrentProjectId, useProjectsList } from "@/hooks/use-projects";
import { writeDefaultProjectCookie } from "@/lib/navigation";
import { CreateProjectDialog } from "./create-project-dialog";

/**
 * Switch between the projects a user can reach, and create new ones.
 *
 * Selection is persisted in a cookie the proxy turns into `X-Project-Id`; see
 * `DEFAULT_PROJECT_COOKIE`. The list comes from the API already filtered to
 * what the caller may use, so there is nothing to gate here — an empty list
 * simply renders nothing.
 */
export const ProjectSwitcher = () => {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: projects = [], isLoading } = useProjectsList();
  const resolvedId = useCurrentProjectId();
  // `useCurrentProjectId` reads the cookie in a mount effect, so it does NOT
  // re-run when we write a new one — router.refresh() re-renders server
  // components but leaves client state alone. Without this the trigger kept
  // showing the old project until a full reload.
  const [pendingId, setPendingId] = useState<string | undefined>();
  const currentId = pendingId ?? resolvedId;
  const [createOpen, setCreateOpen] = useState(false);

  const switchTo = (projectId: string) => {
    if (projectId === currentId) return;
    setPendingId(projectId);
    writeDefaultProjectCookie(projectId);
    // Belt and braces. `getProjectId()` now returns the cookie, so `scope()`
    // already re-keys every query on switch; clearing also drops the old
    // project's entries instead of leaving them cached under a key nobody
    // will ask for again.
    queryClient.clear();
    // The cookie only reaches the server on the next request, and most of this
    // dashboard is server-rendered, so refresh rather than re-render.
    router.refresh();
  };

  // Nothing to switch between and nothing loaded yet — stay out of the way
  // rather than render an empty control.
  if (isLoading || projects.length === 0) return null;

  const current = projects.find((p) => p.id === currentId);
  const label = current?.name ?? current?.slug ?? "Select project";

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              className="data-[state=open]:bg-sidebar-accent"
              tooltip={label}
            >
              <FolderOpen className="size-4 shrink-0" />
              <span className="truncate">{label}</span>
              <ChevronsUpDown className="ml-auto size-4 shrink-0 opacity-50" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            side="bottom"
            className="w-56"
            sideOffset={4}
          >
            {projects.map((project) => (
              <DropdownMenuItem
                key={project.id}
                onSelect={() => switchTo(project.id)}
                className="gap-2"
              >
                <Check
                  className={cn(
                    "size-4 shrink-0",
                    project.id === currentId ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="truncate">
                  {project.name ?? project.slug ?? project.id}
                </span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => setCreateOpen(true)}
              className="gap-2"
            >
              <Plus className="size-4 shrink-0" />
              New project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>

      <CreateProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={switchTo}
      />
    </SidebarMenu>
  );
};
