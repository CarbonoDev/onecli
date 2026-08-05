import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { PageHeader } from "@dashboard/page-header";

export default function Loading() {
  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Webhooks"
        description="Give GitHub, alerting, or any HTTP sender a URL that wakes an agent."
      />
      <div className="space-y-3">
        <div className="flex items-center justify-end">
          <Skeleton className="h-8 w-36 rounded-md" />
        </div>
        <Card className="p-4">
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10 w-full rounded-md" />
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
