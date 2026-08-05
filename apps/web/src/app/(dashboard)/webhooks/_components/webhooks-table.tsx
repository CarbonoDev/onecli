"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Check, Copy, Plus, Webhook } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
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
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { withProjectPrefix } from "@/lib/navigation";
import type { WebhookEndpoint } from "@/lib/api";
import { CreateWebhookDialog } from "./create-webhook-dialog";
import { VerificationBadge } from "./verification-badge";
import { WebhookRowActions } from "./webhook-row-actions";

export interface WebhooksTableProps {
  endpoints: WebhookEndpoint[];
  publicBaseUrl: string;
}

const CopyUrlButton = ({ url }: { url: string }) => {
  const { copied, copy } = useCopyToClipboard();
  return (
    <button
      type="button"
      onClick={() => copy(url)}
      className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
      aria-label="Copy ingest URL"
    >
      {copied ? (
        <Check className="text-brand size-3.5" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </button>
  );
};

export const WebhooksTable = ({
  endpoints,
  publicBaseUrl,
}: WebhooksTableProps) => {
  const [createOpen, setCreateOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="size-3.5" />
          Create endpoint
        </Button>
      </div>

      {endpoints.length === 0 ? (
        <Card className="flex flex-col items-center justify-center py-12 text-center">
          <div className="bg-muted mb-4 flex size-12 items-center justify-center rounded-full">
            <Webhook className="text-muted-foreground size-6" />
          </div>
          <p className="text-sm font-medium">No webhook endpoints yet</p>
          <p className="text-muted-foreground mt-1 max-w-xs text-xs">
            Create an endpoint to give GitHub, alerting, or any HTTP sender a
            URL that wakes an agent.
          </p>
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Ingest URL</TableHead>
                <TableHead>Verification</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Last delivery</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {endpoints.map((row) => {
                const url = `${publicBaseUrl}${row.ingestPath}`;
                return (
                  <TableRow
                    key={row.id}
                    className="cursor-pointer"
                    onClick={() =>
                      router.push(
                        withProjectPrefix(pathname, `/webhooks/${row.id}`),
                      )
                    }
                  >
                    <TableCell>
                      <span className="font-medium">{row.name}</span>
                      {!row.enabled && (
                        <Badge variant="outline" className="ml-2 text-xs">
                          Disabled
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="max-w-64">
                      {/* Interactive control inside a click-through row. */}
                      <div
                        className="flex min-w-0 items-center gap-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <code className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs select-all">
                          {url}
                        </code>
                        <CopyUrlButton url={url} />
                      </div>
                    </TableCell>
                    <TableCell>
                      <VerificationBadge verification={row.verification} />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {row.agentName}
                    </TableCell>
                    <TableCell>
                      {row.lastDeliveryAt ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="text-muted-foreground cursor-default text-xs tabular-nums">
                              {formatRelative(row.lastDeliveryAt)}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" align="start">
                            <p className="text-xs">
                              {formatUTC(row.lastDeliveryAt)}
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <span className="text-muted-foreground text-xs">
                          Never
                        </span>
                      )}
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <WebhookRowActions endpoint={row} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      <CreateWebhookDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        publicBaseUrl={publicBaseUrl}
      />
    </div>
  );
};
