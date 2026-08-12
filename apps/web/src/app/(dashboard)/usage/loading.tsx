import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { PageHeader } from "@dashboard/page-header";

export default function UsageLoading() {
  return (
    <div className="flex flex-1 flex-col gap-6">
      {/* Verbatim from `page.tsx` — this fallback renders the real heading, so
          any drift flashes one title and then swaps to another. */}
      <PageHeader
        title="Usage"
        description="Request volume and per-agent usage across your organization."
      />
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          {[1, 2].map((i) => (
            <Card key={i} className="gap-0 p-6">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="mt-4 h-8 w-24" />
              <Skeleton className="mt-2 h-3 w-40" />
            </Card>
          ))}
        </div>
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    </div>
  );
}
