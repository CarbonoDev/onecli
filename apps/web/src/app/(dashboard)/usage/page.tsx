import type { Metadata } from "next";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { PageHeader } from "@dashboard/page-header";

export const metadata: Metadata = {
  title: "Usage",
};

export default function UsagePage() {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader
        title="Usage"
        description="Request volume and per-agent usage across your organization."
      />
      <Card>
        <CardHeader>
          <CardTitle>Not available yet</CardTitle>
          <CardDescription>
            Usage reporting is on the way. Until then, a project&apos;s Activity
            page shows its gateway requests.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
