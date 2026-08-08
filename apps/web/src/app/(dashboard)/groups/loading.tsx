import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { PageHeader } from "@dashboard/page-header";

export default function GroupsLoading() {
  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Groups"
        description="Organize members into groups for project access and policy."
      />
      <div className="space-y-4">
        {[1, 2].map((i) => (
          <Card key={i} className="p-6">
            <div className="flex items-center justify-between">
              <div className="space-y-2">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-4 w-48" />
              </div>
              <Skeleton className="size-8 rounded-md" />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
