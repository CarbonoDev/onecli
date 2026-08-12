import type { ReactNode } from "react";
import { Card } from "@onecli/ui/components/card";
import { formatCount } from "./format";

export interface UsageStatCardProps {
  title: string;
  /** The window these numbers cover, already formatted. */
  period: string;
  value: number;
  /**
   * What the number counts, in the product's own words. Must stay literally
   * true — see `UsageContent` for why "total gateway requests" is not.
   */
  caption: string;
  /** Optional disclosure rendered beside the title (the recorded-vs-served note). */
  titleAdornment?: ReactNode;
}

export const UsageStatCard = ({
  title,
  period,
  value,
  caption,
  titleAdornment,
}: UsageStatCardProps) => (
  <Card className="gap-0 p-6">
    <div className="flex items-start justify-between gap-4">
      <div className="flex items-center gap-1.5">
        <h2 className="text-sm font-medium">{title}</h2>
        {titleAdornment}
      </div>
      <span className="text-muted-foreground shrink-0 text-xs">{period}</span>
    </div>
    <p className="mt-3 text-3xl font-semibold tabular-nums">
      {formatCount(value)}
    </p>
    <p className="text-muted-foreground mt-1 text-xs">{caption}</p>
  </Card>
);
