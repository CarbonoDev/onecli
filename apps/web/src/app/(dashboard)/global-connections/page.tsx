import type { Metadata } from "next";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { PageHeader } from "@dashboard/page-header";

export const metadata: Metadata = {
  title: "Global Connections",
};

// The segment name matches `connectionsPath`'s documented org base path
// (`/org/<id>/global-connections`), so one name works across editions.
export default function GlobalConnectionsPage() {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader
        title="Global Connections"
        description="Organization-wide app integrations, custom secrets, and LLM keys shared across all projects."
      />
      <Card>
        <CardHeader>
          <CardTitle>Not available yet</CardTitle>
          <CardDescription>
            Organization-wide connections are on the way. Until then, connect
            apps and add secrets from a project&apos;s Connections page.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
