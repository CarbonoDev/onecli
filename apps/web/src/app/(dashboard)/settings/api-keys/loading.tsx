import { Card, CardContent, CardHeader } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { PageHeader } from "@dashboard/page-header";

export default function ApiKeysLoading() {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader
        title="API Keys"
        // Must match page.tsx exactly, or the copy changes as the card loads.
        description="OneCLI issues one personal API key per project. Copy it for the CLI, or regenerate it if it leaks."
      />
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-4 w-64" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-9 w-full rounded-md" />
        </CardContent>
      </Card>
    </div>
  );
}
