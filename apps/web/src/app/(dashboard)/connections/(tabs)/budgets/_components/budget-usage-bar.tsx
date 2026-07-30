import { cn } from "@onecli/ui/lib/utils";

const formatDollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export interface BudgetUsageBarProps {
  spentCents: number;
  limitCents: number;
  period: "monthly" | "total";
}

/**
 * Spend meter: `$X of $Y this month`, filling green → amber (≥80%) → red
 * (≥100%). Accessible in light and dark; the track/fill carry a text label so
 * the state does not rely on color alone.
 */
export const BudgetUsageBar = ({
  spentCents,
  limitCents,
  period,
}: BudgetUsageBarProps) => {
  const ratio = limitCents > 0 ? spentCents / limitCents : 0;
  const pct = Math.min(Math.max(ratio, 0), 1) * 100;
  const over = spentCents >= limitCents && limitCents > 0;
  const warn = ratio >= 0.8;

  const fill = over
    ? "bg-red-500 dark:bg-red-500"
    : warn
      ? "bg-amber-500 dark:bg-amber-400"
      : "bg-emerald-500 dark:bg-emerald-400";

  return (
    <div className="flex flex-col gap-1 min-w-[9rem]">
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={`Spend ${period === "monthly" ? "this month" : "total"}`}
        aria-valuemin={0}
        aria-valuemax={limitCents}
        aria-valuenow={spentCents}
        aria-valuetext={`${formatDollars(spentCents)} of ${formatDollars(limitCents)}`}
      >
        <div
          className={cn("h-full rounded-full transition-all", fill)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p
        className={cn(
          "text-xs tabular-nums text-muted-foreground",
          over && "text-red-600 dark:text-red-400 font-medium",
        )}
      >
        {formatDollars(spentCents)} of {formatDollars(limitCents)}{" "}
        {period === "monthly" ? "this month" : "total"}
        {over && " — cap reached"}
      </p>
    </div>
  );
};
