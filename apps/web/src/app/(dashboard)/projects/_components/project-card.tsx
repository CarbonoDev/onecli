"use client";

import { Folder } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { Card } from "@onecli/ui/components/card";
import type { Project } from "@/lib/api";
import { useSwitchProject } from "@/hooks/use-switch-project";
import { ProjectRowActions } from "./project-row-actions";

export interface ProjectCardProps {
  project: Project;
  /** The selected project, badged `Current`. Resolved once by the grid. */
  isCurrent: boolean;
  sharingEnabled: boolean;
}

/**
 * One meta segment, or `null` when the count didn't arrive — the segment drops
 * out of the join rather than rendering `undefined agents` beside a bare `·`.
 */
const countLabel = (value: number, singular: string) =>
  Number.isFinite(value)
    ? `${value} ${value === 1 ? singular : `${singular}s`}`
    : null;

export const ProjectCard = ({
  project,
  isCurrent,
  sharingEnabled,
}: ProjectCardProps) => {
  const switchTo = useSwitchProject();

  // The switcher's fallback chain — legacy rows carry NULL names, and some
  // also a NULL slug.
  const label = project.name ?? project.slug ?? project.id;
  const meta = [
    countLabel(project.agentCount, "agent"),
    countLabel(project.resourceCount, "resource"),
  ]
    .filter((segment) => segment !== null)
    .join(" · ");

  return (
    // The whole card enters the project through the STRETCHED name button —
    // one real, focusable, announced control widened to the card's bounds,
    // never an onClick on the Card itself. `focus-within` puts the ring on the
    // card rather than around the name text alone.
    <Card className="hover:border-muted-foreground/30 focus-within:ring-ring/50 relative gap-0 p-5 transition-colors focus-within:ring-[3px]">
      <div className="flex items-start justify-between gap-2">
        <div className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-lg">
          <Folder className="text-muted-foreground size-5" />
        </div>
        {/* The kebab is painted ABOVE the name button's stretched overlay, so
            its clicks land on the trigger directly. That is also why nothing
            here calls stopPropagation: there is no ancestor onClick left to
            swallow the event. If a later refactor moves the enter-project
            handler onto the Card, Rename / Delete / Manage access become
            unreachable again without it.
            `z-10`, not bare `relative` as on AgentCard: positioned siblings at
            `z-index: auto` paint in TREE order, and the kebab sits before the
            name in the DOM here, so the overlay would otherwise cover it. */}
        <div className="relative z-10 -mt-1 -mr-1">
          <ProjectRowActions
            project={project}
            sharingEnabled={sharingEnabled}
          />
        </div>
      </div>

      <div className="mt-4 flex min-w-0 items-center gap-2">
        <h3 className="min-w-0 text-sm font-medium">
          <button
            type="button"
            onClick={() => switchTo(project.id)}
            // Truncation without recovery: the card is a third of the row, so
            // a long name needs somewhere to be read in full. The accessible
            // name still comes from the content, not this.
            title={label}
            // Explicit `cursor-pointer`: Tailwind's preflight gives buttons
            // `cursor: default`, which would disagree with a card-wide target.
            // The outline is dropped because the card's focus ring is the
            // keyboard indicator — the two together would double up.
            className="max-w-full cursor-pointer truncate hover:underline after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
          >
            {label}
          </button>
        </h3>
        {isCurrent && (
          // Outside the button: the accessible name of the control is the
          // project name, not "Binnacle Current".
          <Badge variant="secondary" className="shrink-0 text-xs">
            Current
          </Badge>
        )}
      </div>

      {meta && <p className="text-muted-foreground mt-1 text-xs">{meta}</p>}

      {/* Provenance, not live identity: the address that created the project.
          Nullable on legacy rows, and then the line is simply absent. */}
      {project.ownerEmail && (
        <p
          className="text-muted-foreground mt-3 truncate text-xs"
          title={project.ownerEmail}
        >
          Owned by {project.ownerEmail}
        </p>
      )}
    </Card>
  );
};
