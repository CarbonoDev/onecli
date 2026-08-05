"use client";

import { Card } from "@onecli/ui/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@onecli/ui/components/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { formatRelative, formatUTC } from "@onecli/api/lib/format";
import type { WebhookDelivery } from "@/lib/api";
import { DeliveryStatusBadge } from "./delivery-status-badge";

export interface DeliveriesTableProps {
  deliveries: WebhookDelivery[];
  onRowClick: (delivery: WebhookDelivery) => void;
  emptyMessage: string;
}

const DateCell = ({ value }: { value: string }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <span className="text-muted-foreground cursor-default text-xs tabular-nums">
        {formatRelative(value)}
      </span>
    </TooltipTrigger>
    <TooltipContent side="bottom" align="start" className="text-xs">
      <p>{formatUTC(value)}</p>
      <p className="text-muted-foreground">
        {new Date(value).toLocaleString()}
      </p>
    </TooltipContent>
  </Tooltip>
);

export const DeliveriesTable = ({
  deliveries,
  onRowClick,
  emptyMessage,
}: DeliveriesTableProps) => {
  if (deliveries.length === 0) {
    return (
      <Card className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-muted-foreground text-sm">{emptyMessage}</p>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden p-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Received</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Event</TableHead>
            <TableHead>Attempts</TableHead>
            <TableHead>Error</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {deliveries.map((delivery) => (
            <TableRow
              key={delivery.id}
              className="cursor-pointer"
              onClick={() => onRowClick(delivery)}
            >
              <TableCell>
                <DateCell value={delivery.receivedAt} />
              </TableCell>
              <TableCell>
                <DeliveryStatusBadge delivery={delivery} />
              </TableCell>
              <TableCell className="text-xs">
                {delivery.event ?? (
                  <span className="text-muted-foreground">—</span>
                )}
                {delivery.replayOfId && (
                  <span className="text-muted-foreground ml-2 text-xs">
                    (replay)
                  </span>
                )}
                {delivery.duplicateCount > 0 && (
                  <span className="text-muted-foreground ml-2 text-xs">
                    +{delivery.duplicateCount} duplicate
                    {delivery.duplicateCount === 1 ? "" : "s"}
                  </span>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground text-xs tabular-nums">
                {delivery.attempts}
              </TableCell>
              <TableCell className="text-destructive max-w-64 truncate text-xs">
                {delivery.lastError}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
};
