import { Suspense } from "react";
import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { getAuthMode } from "@/lib/auth/auth-mode";
import { TeamContent } from "./_components/team-content";

// "Members", matching the org shell's nav item and the breadcrumb. The route
// stays `/team` so existing links and bookmarks keep working — only the name
// the user reads changed.
export const metadata: Metadata = {
  title: "Members",
};

export default function TeamPage() {
  // Auth mode is server-only (fs-backed runtime config), so it is resolved
  // here and threaded down as a prop (the AgentsContent precedent). No
  // server-side auth/role resolution at page level — no dashboard page does
  // it, and the API's 403 is the authority on who is an admin (D-K).
  const teamEnabled = getAuthMode() !== "local";

  return (
    <div className="flex flex-1 flex-col gap-6">
      {/* Keep in sync with `loading.tsx`, which renders this same header so
          the heading doesn't change while the list resolves. */}
      <PageHeader
        title="Members"
        description="Manage members and roles for your organization."
      />
      <Suspense>
        <TeamContent teamEnabled={teamEnabled} />
      </Suspense>
    </div>
  );
}
