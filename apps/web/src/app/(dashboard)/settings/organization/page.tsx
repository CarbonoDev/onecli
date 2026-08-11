import { Suspense } from "react";
import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { resolveProjectContext } from "@/lib/actions/resolve-user";
import { OrganizationSettingsContent } from "./_components/organization-settings-content";

export const metadata: Metadata = {
  title: "Organization",
};

export default async function OrganizationSettingsPage() {
  // The org cookie is the authority on which org is selected, but it lives on
  // `document` and can only be read in an effect — so the server resolves the
  // caller's org through the SAME helper the server actions use, and the client
  // uses it only until the cookie answers. A single-org user (no cookie) never
  // needs anything else.
  const { organizationId } = await resolveProjectContext();

  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader
        title="Organization"
        description="Rename the organization you are working in."
      />
      <Suspense>
        <OrganizationSettingsContent fallbackOrganizationId={organizationId} />
      </Suspense>
    </div>
  );
}
