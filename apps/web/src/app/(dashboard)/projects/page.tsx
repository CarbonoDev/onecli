import { Suspense } from "react";
import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { getAuthMode } from "@/lib/auth/auth-mode";
import { ProjectsContent } from "./_components/projects-content";

export const metadata: Metadata = {
  title: "Projects",
};

// Deliberately NO resolveProjectContext here: it throws "No project found" in
// exactly the org-with-no-reachable-project state this page exists to rescue
// (the #31 empty state creates the first project).
export default function ProjectsPage() {
  // Auth mode is server-only (fs-backed runtime config), so it is resolved
  // here and threaded down as a prop (the /groups + /team precedent). Local
  // mode has exactly one identity, so sharing is inert — the access dialog is
  // the only thing gated.
  const sharingEnabled = getAuthMode() !== "local";

  return (
    <div className="flex flex-1 flex-col gap-6">
      {/* "you can reach", not "the org has": a non-admin only sees their
          bindings, so the copy must not read as the org's full inventory. */}
      <PageHeader
        title="Projects"
        description="Projects you can reach in this organization."
      />
      <Suspense>
        <ProjectsContent sharingEnabled={sharingEnabled} />
      </Suspense>
    </div>
  );
}
