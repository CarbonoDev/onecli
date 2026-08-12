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
 * One meta segment. Both counts are non-nullable in the API contract, so the
 * `null` branch is unreachable by type — it is belt-and-braces against a stale
 * server that predates the field, and it keeps the separator honest: a dropped
 * segment takes its `·` with it instead of leaving a bare one behind.
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
    // never an onClick on the Card itself.
    //
    // `isolate` makes the Card a stacking context, so the kebab's `z-10` below
    // is scoped to this card instead of competing in the root context (where it
    // would tie with the fixed sidebar's `z-10` and win on tree order).
    //
    // The ring is gated on `:focus-visible`, not `:focus-within`: the latter
    // also matches a MOUSE click on the kebab, which would leave a 3px ring
    // around the whole card after the menu closed.
    <Card className="hover:border-muted-foreground/30 has-[:focus-visible]:ring-ring/50 relative isolate h-full gap-0 p-5 transition-colors has-[:focus-visible]:ring-[3px]">
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
            // The recovery for a truncated name. It reads card-wide, since the
            // stretched overlay belongs to this button — which is exactly why
            // the owner line below can't have one of its own. The accessible
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
          Nullable on legacy rows, and then the line is simply absent.

          Wraps rather than truncates. A `title` here would be dead weight — the
          stretched overlay is positioned, so it wins hit-testing over this
          non-positioned text and the name button's tooltip is what a hover
          actually resolves to. Wrapping is a recovery the overlay can't cover.
          `h-full` on the Card keeps a wrapped card level with its row. */}
      {project.ownerEmail && (
        <p className="text-muted-foreground mt-3 text-xs break-words">
          Owned by {project.ownerEmail}
        </p>
      )}
    </Card>
  );
};
