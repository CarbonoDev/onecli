import { PageHeader } from "@dashboard/page-header";
import { ProjectsSkeleton } from "./_components/projects-skeleton";

export default function ProjectsLoading() {
  return (
    <div className="flex flex-1 flex-col gap-6">
      {/* Kept verbatim in step with `page.tsx` — this renders the real
          PageHeader, so a drift here shows up as the title changing on load. */}
      <PageHeader
        title="Projects"
        description="Projects you can reach in this organization."
      />
      <ProjectsSkeleton />
    </div>
  );
}
