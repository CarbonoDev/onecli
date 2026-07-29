import { Suspense } from "react";
import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { getAuthMode } from "@/lib/auth/auth-mode";
import { TeamContent } from "./_components/team-content";

export const metadata: Metadata = {
  title: "Team",
};

export default function TeamPage() {
  // Auth mode is server-only (fs-backed runtime config), so it is resolved
  // here and threaded down as a prop (the AgentsContent precedent). No
  // server-side auth/role resolution at page level — no dashboard page does
  // it, and the API's 403 is the authority on who is an admin (D-K).
  const teamEnabled = getAuthMode() !== "local";

  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Team"
        description="Manage your organization's members and invite teammates."
      />
      <Suspense>
        <TeamContent teamEnabled={teamEnabled} />
      </Suspense>
    </div>
  );
}
