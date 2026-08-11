import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { PageHeader } from "@dashboard/page-header";

export default function OrganizationSettingsLoading() {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader
        title="Organization"
        description="Rename the organization you are working in."
      />
      <Card className="p-6">
        <div className="space-y-3">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-9 w-full max-w-sm" />
        </div>
      </Card>
    </div>
  );
}
