import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { UsageContent } from "./_components/usage-content";

export const metadata: Metadata = {
  title: "Usage",
};

export default function UsagePage() {
  return (
    <div className="flex flex-1 flex-col gap-6">
      {/* "the projects you can access", NOT "your organization": this route is
          member-visible with per-project fencing, so a member bound to one of
          five projects sees one project's traffic. An org-wide claim here would
          overstate coverage exactly as "total gateway requests" would overstate
          the recorded-vs-served gap on the cards.

          Keep in sync with `loading.tsx`, which renders this same header so the
          heading doesn't change while the summary resolves. */}
      <PageHeader
        title="Usage"
        description="Request volume and per-agent usage across the projects you can access."
      />
      {/* No `Suspense`: `UsageContent` is a client component using `useQuery`,
          which never suspends. `loading.tsx` covers the navigation boundary and
          the component renders its own skeleton while fetching. */}
      <UsageContent />
    </div>
  );
}
