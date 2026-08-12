"use client";

import { Progress } from "@onecli/ui/components/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@onecli/ui/components/table";
import { TableCard } from "@/components/table-card";
import type { UsageAgentRow } from "@/lib/api";
import { formatCount, shareOfTotal } from "./format";

export interface UsageByAgentTableProps {
  agents: UsageAgentRow[];
  /** Denominator for the bars — the summary total, so bars and cards agree. */
  totalRequests: number;
}

// The bar is a SHARE-OF-TOTAL indicator, deliberately not `BudgetUsageBar`:
// that one is a spend-vs-cap meter with threshold colors and dollar labels, and
// none of those readings apply here (there is no cap to approach and no amount
// to overspend). `Progress` is styled from the outside with a descendant
// variant — the same technique `TableCard` uses, and already proven on
// `connect-layout.tsx`, so `packages/ui` stays zero-diff.
const BAR_CLASSES =
  "bg-muted h-1.5 [&>[data-slot=progress-indicator]]:bg-brand";

export const UsageByAgentTable = ({
  agents,
  totalRequests,
}: UsageByAgentTableProps) => (
  <TableCard>
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Agent</TableHead>
          {/* The bar column is unlabeled: it re-encodes the Requests column, so
              a header would name a second, non-existent measure. */}
          <TableHead className="w-1/3" />
          <TableHead className="text-right">Requests</TableHead>
          <TableHead className="text-right">Integration calls</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {agents.map((row) => {
          const share = shareOfTotal(row.requests, totalRequests);
          return (
            <TableRow key={row.agentId}>
              <TableCell className="font-medium">
                {row.agentName ?? (
                  // `request_logs.agent_id` has no foreign key, so rows outlive
                  // their agent. The row is kept rather than dropped so the
                  // table still sums to the cards.
                  <span className="text-muted-foreground italic">
                    Deleted agent
                  </span>
                )}
              </TableCell>
              <TableCell>
                <Progress
                  value={share}
                  className={BAR_CLASSES}
                  aria-label={`${row.agentName ?? "Deleted agent"} share of recorded requests`}
                />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCount(row.requests)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCount(row.integrationCalls)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  </TableCard>
);
