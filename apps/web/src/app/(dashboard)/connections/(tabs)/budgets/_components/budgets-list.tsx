"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@onecli/ui/components/table";
import { Badge } from "@onecli/ui/components/badge";
import type { Budget } from "@/lib/api";
import { BudgetUsageBar } from "./budget-usage-bar";
import { BudgetRowActions } from "./budget-row-actions";

export interface BudgetsListProps {
  budgets: Budget[];
}

export const BudgetsList = ({ budgets }: BudgetsListProps) => {
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Secret</TableHead>
            <TableHead>Provider</TableHead>
            <TableHead>Period</TableHead>
            <TableHead>Usage</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {budgets.map((b) => (
            <TableRow key={b.id}>
              <TableCell className="font-medium">{b.secretName}</TableCell>
              <TableCell>
                <Badge variant="secondary">{b.secretType}</Badge>
              </TableCell>
              <TableCell className="capitalize text-muted-foreground">
                {b.period}
              </TableCell>
              <TableCell>
                <BudgetUsageBar
                  spentCents={b.spentCents}
                  limitCents={b.limitCents}
                  period={b.period}
                />
              </TableCell>
              <TableCell>
                <BudgetRowActions budget={b} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};
