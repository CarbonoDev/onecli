import { Suspense } from "react";
import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { getAuthMode } from "@/lib/auth/auth-mode";
import { GroupsContent } from "./_components/groups-content";

export const metadata: Metadata = {
  title: "Groups",
};

export default function GroupsPage() {
  // Auth mode is server-only (fs-backed runtime config), so it is resolved
  // here and threaded down as a prop (the TeamContent precedent). Local mode
  // gates groups entirely — one built-in identity means nobody to group. No
  // server-side auth/role resolution at page level — no dashboard page does
  // it, and the API's 403 is the authority on who is an admin.
  const groupsEnabled = getAuthMode() !== "local";

  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Groups"
        description="Organize members into groups for project access and policy."
      />
      <Suspense>
        <GroupsContent groupsEnabled={groupsEnabled} />
      </Suspense>
    </div>
  );
}
