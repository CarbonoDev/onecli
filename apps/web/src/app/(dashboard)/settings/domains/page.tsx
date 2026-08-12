import { Suspense } from "react";
import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { getAuthMode } from "@/lib/auth/auth-mode";
import { DomainsContent } from "./_components/domains-content";

export const metadata: Metadata = {
  title: "Domains",
};

export default function DomainsPage() {
  // Auth mode is server-only (fs-backed runtime config), so it is resolved
  // here and threaded down as a prop (the GroupsContent precedent). Local mode
  // gates domains entirely — the one built-in identity is `admin@localhost`,
  // which no claimable domain can ever cover. No server-side auth/role
  // resolution at page level: no dashboard page does it, and the API's 403 is
  // the authority on who is an admin.
  const domainsEnabled = getAuthMode() !== "local";

  return (
    <div className="flex flex-1 flex-col gap-4">
      {/* The spec's subtitle ended "— the foundation for single sign-on."
          That clause is dropped: this branch deletes the SSO page, and a
          subtitle pointing at a surface that doesn't exist is a promise the
          product can't keep. */}
      <PageHeader
        title="Domains"
        description="Claim your company's email domains and verify them via DNS."
      />
      <Suspense>
        <DomainsContent domainsEnabled={domainsEnabled} />
      </Suspense>
    </div>
  );
}
