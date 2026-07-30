import { Suspense } from "react";
import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { getAuthMode } from "@/lib/auth/auth-mode";
import { resolveProjectContext } from "@/lib/actions/resolve-user";
import { ProjectSettingsContent } from "./_components/project-settings-content";

export const metadata: Metadata = {
  title: "Project",
};

export default async function ProjectSettingsPage() {
  // Auth mode is server-only (fs-backed runtime config), so it is resolved here
  // and threaded down (the /groups + /team precedent). Local mode has exactly
  // one identity, so sharing is inert — rename and delete stay live.
  const sharingEnabled = getAuthMode() !== "local";
  // OSS sends no `X-Project-Id`, and the client session carries no project id,
  // so the active project is resolved here — through the SAME helper the server
  // actions use, which gates identically to the API's `resolveProjectId`.
  const { projectId, userId } = await resolveProjectContext();

  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader
        title="Project"
        description="Rename this project, choose who can use it, or delete it."
      />
      <Suspense>
        <ProjectSettingsContent
          projectId={projectId}
          userId={userId}
          sharingEnabled={sharingEnabled}
        />
      </Suspense>
    </div>
  );
}
