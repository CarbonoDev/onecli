import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { PageHeader } from "@dashboard/page-header";

export default function ProjectSettingsLoading() {
  return (
    <div className="flex flex-1 flex-col gap-4">
      {/* Verbatim from `page.tsx` — this fallback renders the real heading, so
          any drift flashes one title and then swaps to another. */}
      <PageHeader
        title="Project Settings"
        description="Rename this project, choose who can use it, or delete it."
      />
      {/* Same count as `project-settings-content.tsx`'s own skeleton, which
          takes over from this one: Name, Details, Access, Delete. */}
      {[1, 2, 3, 4].map((i) => (
        <Card key={i} className="p-6">
          <div className="space-y-3">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-9 w-full max-w-sm" />
          </div>
        </Card>
      ))}
    </div>
  );
}
