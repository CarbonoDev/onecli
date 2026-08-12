"use client";

import { Check, Copy } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import type { Project } from "@/lib/api";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

export interface ProjectDetailsCardProps {
  project: Project;
}

/**
 * The dashboard's date format, pinned to `en-US` for the reason every other
 * call site pins it (`team/_components/member-row.tsx`,
 * `groups/_components/groups-table.tsx`, `usage/_components/format.ts`): an
 * unpinned locale renders from the runtime's, which differs between the server
 * that pre-renders and the browser that hydrates.
 */
const formatCreated = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

/**
 * The project's read-only identity: the id, and the date it was created.
 *
 * Neither field earns a card alone. The id is the more useful half — it is the
 * value that identifies a project to the API and in a bug report, and nothing
 * in the app displays it except as the switcher's last-resort label when a
 * legacy row has neither name nor slug. `createdAt` is the half with nowhere
 * else to go: the /projects grid became cards and dropped the table's `Created`
 * column with them, so this is the only surface that renders it.
 *
 * The slug is deliberately absent. It is immutable (see the PATCH route) and
 * every use of it in the app is a fallback label behind `name` — it identifies
 * nothing a caller can act on, so it would be a third row of noise.
 *
 * Same read-only-code shape as the instance page's Build version / Public URL
 * cards and the domains page's DNS record fields.
 */
export const ProjectDetailsCard = ({ project }: ProjectDetailsCardProps) => {
  const { copied, copy } = useCopyToClipboard();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Details</CardTitle>
        <CardDescription>
          The stable identifier for this project, and when it was created.
          Include the ID when reporting an issue.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="max-w-sm space-y-1">
          <p className="text-muted-foreground text-[11px] font-medium tracking-wider uppercase">
            Project ID
          </p>
          <div className="flex items-center gap-2">
            <div className="bg-muted/50 flex min-w-0 flex-1 items-center rounded-md border px-3 py-2">
              {/* `break-all`, not `truncate`: an id half-hidden behind an
                  ellipsis cannot be read back or compared by eye, and the copy
                  button is not a substitute for either. */}
              <code className="min-w-0 flex-1 font-mono text-xs break-all">
                {project.id}
              </code>
            </div>
            <button
              type="button"
              onClick={() => copy(project.id)}
              aria-label={copied ? "Project ID copied" : "Copy project ID"}
              className="text-muted-foreground hover:text-foreground shrink-0 rounded-md border p-2 transition-colors"
            >
              {copied ? (
                <Check className="text-brand size-4" aria-hidden />
              ) : (
                <Copy className="size-4" aria-hidden />
              )}
            </button>
          </div>
        </div>

        <div className="space-y-1">
          <p className="text-muted-foreground text-[11px] font-medium tracking-wider uppercase">
            Created
          </p>
          {/* The machine-readable ISO stays on the element, so the value is
              recoverable whatever the rendered format says. */}
          <time dateTime={project.createdAt} className="text-sm">
            {formatCreated(project.createdAt)}
          </time>
        </div>
      </CardContent>
    </Card>
  );
};
