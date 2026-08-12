import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Card } from "@onecli/ui/components/card";
import { cn } from "@onecli/ui/lib/utils";

type EmptyStateVariant = "card" | "dashed";

/**
 * Title copy. The happy path is `things` — it renders `No <things> yet`, so the
 * inventory-empty formula can't drift. `title` is the mutually exclusive escape
 * hatch for states that aren't "an empty list" (e.g. `Admins only`).
 */
type EmptyStateCopy =
  | { things: string; title?: never }
  | { title: string; things?: never };

export type EmptyStateProps = {
  icon: LucideIcon;
  /** Copy formula: `<Verb> a <thing> to <outcome>.` One sentence, ends in a period. */
  description: string;
  /**
   * `card` — the empty state REPLACES the whole page surface (admin-only,
   * local-mode, or a page whose only content is the list).
   * `dashed` — the empty state sits INSIDE a page that has other content
   * (a section among sections). Defaults to `card`.
   */
  variant?: EmptyStateVariant;
  /** Optional call to action rendered below the description. */
  action?: ReactNode;
  className?: string;
} & EmptyStateCopy;

// Card's base is `flex flex-col gap-6 rounded-xl border py-6`; `gap-0 py-0`
// neutralises the flex gap and vertical padding so all spacing below is
// controlled by the badge/title/body margins alone.
const FRAME_CLASSES: Record<EmptyStateVariant, string> = {
  card: "min-h-[230px] gap-0 px-6 py-0",
  dashed: "min-h-[140px] rounded-xl border border-dashed px-6",
};

const BADGE_CLASSES: Record<EmptyStateVariant, string> = {
  card: "mb-4 size-12",
  dashed: "mb-3 size-10",
};

const ICON_CLASSES: Record<EmptyStateVariant, string> = {
  card: "size-6",
  dashed: "size-5",
};

const LAYOUT_CLASSES = "flex flex-col items-center justify-center text-center";

export const EmptyState = ({
  icon: Icon,
  description,
  variant = "card",
  action,
  className,
  title: explicitTitle,
  things,
}: EmptyStateProps) => {
  const title = explicitTitle ?? `No ${things} yet`;
  const body = (
    <>
      <div
        className={cn(
          "bg-muted flex items-center justify-center rounded-full",
          BADGE_CLASSES[variant],
        )}
      >
        <Icon className={cn("text-muted-foreground", ICON_CLASSES[variant])} />
      </div>
      <p className="text-sm font-medium">{title}</p>
      <p className="text-muted-foreground mt-1 max-w-xs text-xs">
        {description}
      </p>
      {action && <div className="mt-4">{action}</div>}
    </>
  );

  return variant === "card" ? (
    <Card className={cn(LAYOUT_CLASSES, FRAME_CLASSES.card, className)}>
      {body}
    </Card>
  ) : (
    <div className={cn(LAYOUT_CLASSES, FRAME_CLASSES.dashed, className)}>
      {body}
    </div>
  );
};
