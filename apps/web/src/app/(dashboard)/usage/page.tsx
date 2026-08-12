import { Suspense } from "react";
import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { UsageContent } from "./_components/usage-content";

export const metadata: Metadata = {
  title: "Usage",
};

export default function UsagePage() {
  return (
    <div className="flex flex-1 flex-col gap-6">
      {/* Keep in sync with `loading.tsx`, which renders this same header so the
          heading doesn't change while the summary resolves. */}
      <PageHeader
        title="Usage"
        description="Request volume and per-agent usage across your organization."
      />
      <Suspense>
        <UsageContent />
      </Suspense>
    </div>
  );
}
