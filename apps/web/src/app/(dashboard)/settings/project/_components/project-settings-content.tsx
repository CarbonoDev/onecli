"use client";

import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { useProject } from "@/hooks/use-projects";
import { useProjectAccess } from "@/hooks/use-project-access";
import { useOrgMembersList } from "@/hooks/use-org-members";
import { ProjectNameCard } from "./project-name-card";
import { ProjectDetailsCard } from "./project-details-card";
import { ProjectAccessCard } from "./project-access-card";
import { DeleteProjectCard } from "./delete-project-card";
import { ReadOnlyNotice } from "../../_components/read-only-notice";

export interface ProjectSettingsContentProps {
  projectId: string;
  /** The signed-in user's DB id — the same id `ProjectAccessUserRow` carries. */
  userId: string;
  /** Threaded from the RSC page (server-only auth mode); false = local mode. */
  sharingEnabled: boolean;
}

export const ProjectSettingsContent = ({
  projectId,
  userId,
  sharingEnabled,
}: ProjectSettingsContentProps) => {
  const project = useProject(projectId);
  const access = useProjectAccess(projectId, sharingEnabled);
  // Doubles as the ADMIN PROBE and as the sharing dialog's candidate feed (one
  // query key, so the dialog reuses this fetch). `/v1/org/members` is
  // admin-only, so a success means "org admin" and a 403 means "not".
  const orgMembers = useOrgMembersList(sharingEnabled);

  // `canManage` is a DISPLAY hint, never an authorization decision — the API's
  // 403 is the authority, and every mutation surfaces its message as a toast.
  // Both signals come from data already fetched: an owner binding of my own, or
  // a successful admin-only directory read.
  const isOrgAdmin = orgMembers.isSuccess;
  const holdsOwnerBinding = Boolean(
    access.data?.users.some((u) => u.userId === userId && u.role === "owner"),
  );
  // LOCAL MODE (`!sharingEnabled`, the default OSS self-host) short-circuits:
  // both probes above are disabled queries there, so neither can ever answer.
  // That single built-in identity is the organization's owner, so rename and
  // delete stay live — only the sharing card degrades. The API still decides:
  // `canManageProject` resolves the local identity's org role through the
  // ossRoleResolver, and its 403 would surface as a toast.
  const canManage = !sharingEnabled || isOrgAdmin || holdsOwnerBinding;

  // Both probes are also the reason the page waits: rendering before they
  // settle would flash every control disabled for a legitimate owner (an
  // orgMembers 403 settles as `isError`, so a non-admin does not wait twice).
  const probesPending =
    sharingEnabled && (orgMembers.isPending || access.isPending);

  if (project.isPending || probesPending) {
    return (
      <>
        {/* One per card below (Name, Details, Access, Delete), and the same
            count as `loading.tsx` — the two fallbacks hand over to each other,
            so a mismatch is a visible jump mid-load. */}
        {[1, 2, 3, 4].map((i) => (
          <Card key={i} className="p-6">
            <div className="space-y-3">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-64" />
              <Skeleton className="h-9 w-full max-w-sm" />
            </div>
          </Card>
        ))}
      </>
    );
  }

  if (project.isError || !project.data) {
    // A plain card: no retry, no toast — the failure is deterministic.
    return (
      <Card className="p-6">
        <p className="text-sm font-medium">Couldn&apos;t load this project</p>
        <p className="text-muted-foreground mt-1 text-xs">
          Something went wrong fetching the project. Reload the page to try
          again.
        </p>
      </Card>
    );
  }

  return (
    <>
      {!canManage && (
        <ReadOnlyNotice description="Only a project owner or an organization admin can rename this project, change who can use it, or delete it." />
      )}
      <ProjectNameCard project={project.data} canManage={canManage} />
      {/* Read-only, so it takes no `canManage` — there is nothing here to
          refuse, and anyone who can reach this page has already passed the
          route's read gate (`requireReadableProject`). */}
      <ProjectDetailsCard project={project.data} />
      <ProjectAccessCard
        projectId={projectId}
        userId={userId}
        canManage={canManage}
        isOrgAdmin={isOrgAdmin}
        sharingEnabled={sharingEnabled}
      />
      <DeleteProjectCard project={project.data} canManage={canManage} />
    </>
  );
};
