import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";

/**
 * The grid's loading shape, shared by `loading.tsx` (the route-level shell)
 * and `projects-content.tsx` (the client query's pending state) so the two
 * can't drift into different placeholders for the same list.
 */
export const ProjectsSkeleton = () => (
  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
    {[1, 2, 3].map((i) => (
      <Card key={i} className="gap-0 p-5">
        <div className="flex items-start justify-between gap-2">
          <Skeleton className="size-10 rounded-lg" />
          <Skeleton className="size-8 rounded-md" />
        </div>
        <Skeleton className="mt-4 h-5 w-32" />
        <Skeleton className="mt-2 h-3 w-40" />
        <Skeleton className="mt-4 h-3 w-48" />
      </Card>
    ))}
  </div>
);
