import { Suspense } from "react";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { PageHeader } from "@dashboard/page-header";
import { resolveProjectContext } from "@/lib/actions/resolve-user";
import { DEFAULT_ORG_COOKIE } from "@/lib/navigation";
import { OrganizationSettingsContent } from "./_components/organization-settings-content";

export const metadata: Metadata = {
  title: "Organization",
};

/**
 * The org this page starts on, resolved server-side purely so the first paint
 * is not blank. The client is the AUTHORITY — `useCurrentOrganizationId` reads
 * the same cookie and wins the moment it answers — so every arm here is allowed
 * to come back empty without costing the page anything.
 *
 * 1. The org cookie, read exactly as `proxy.ts` reads it (same constant, raw
 *    value): it is what the proxy will send as `X-Organization-Id`, so it is
 *    the org the PATCH would actually be scoped to.
 * 2. Otherwise the caller's resolved project's org — the cookie-less single-org
 *    case. `resolveProjectContext` THROWS for a user with no project, and "this
 *    org, no project yet" is a first-class state the org stack supports, so the
 *    throw is caught rather than allowed to crash an org page.
 * 3. Otherwise nothing, and the client resolves it alone.
 */
const resolveInitialOrganizationId = async (): Promise<string | undefined> => {
  const cookieOrgId = (await cookies()).get(DEFAULT_ORG_COOKIE)?.value;
  if (cookieOrgId) return cookieOrgId;

  try {
    return (await resolveProjectContext()).organizationId;
  } catch {
    return undefined;
  }
};

export default async function OrganizationSettingsPage() {
  const organizationId = await resolveInitialOrganizationId();

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
