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
      // Margins and line boxes track ProjectCard exactly — mt-4 / mt-1 / mt-3,
      // and the kebab's -mt-1 -mr-1 — so the real card lands without a shift.
      <Card key={i} className="gap-0 p-5">
        <div className="flex items-start justify-between gap-2">
          <Skeleton className="size-10 rounded-lg" />
          <Skeleton className="-mt-1 -mr-1 size-8 rounded-md" />
        </div>
        <Skeleton className="mt-4 h-5 w-32" />
        <Skeleton className="mt-1 h-4 w-40" />
        <Skeleton className="mt-3 h-4 w-48" />
      </Card>
    ))}
  </div>
);
