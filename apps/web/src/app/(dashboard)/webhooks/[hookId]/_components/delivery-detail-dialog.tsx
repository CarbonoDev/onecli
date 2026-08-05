"use client";

import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { formatUTC } from "@onecli/api/lib/format";
import { useDeliveryDetail, useReplayDelivery } from "@/hooks/use-webhooks";
import type { WebhookDelivery } from "@/lib/api";
import { DeliveryStatusBadge } from "./delivery-status-badge";

export interface DeliveryDetailDialogProps {
  delivery: WebhookDelivery | null;
  hookId: string;
  onClose: () => void;
}

const Row = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <div className="border-border/50 flex items-center justify-between border-b py-2 last:border-b-0">
    <span className="text-muted-foreground text-sm">{label}</span>
    <div className="max-w-[60%] truncate text-sm">{children}</div>
  </div>
);

const Block = ({ label, children }: { label: string; children: string }) => (
  <div className="mt-3 space-y-1.5">
    <span className="text-muted-foreground text-xs font-medium">{label}</span>
    <pre className="bg-muted max-h-64 overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">
      {children}
    </pre>
  </div>
);

export const DeliveryDetailDialog = ({
  delivery,
  hookId,
  onClose,
}: DeliveryDetailDialogProps) => {
  // The list row carries no payload — fetch the full record on open.
  const detail = useDeliveryDetail(delivery?.id ?? null);
  const replay = useReplayDelivery(hookId);

  // A rejected delivery was never stored with its payload, so there is nothing
  // to re-render.
  const replayable = delivery?.discardReason !== "rejected";

  return (
    <Dialog open={Boolean(delivery)} onOpenChange={() => onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Delivery</DialogTitle>
        </DialogHeader>

        {detail.isPending ? (
          <div className="space-y-2 py-2">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-8 w-full rounded-md" />
            ))}
          </div>
        ) : detail.isError ? (
          <p className="text-destructive py-4 text-sm">
            {detail.error.message}
          </p>
        ) : (
          detail.data && (
            <div className="max-h-[60vh] overflow-y-auto">
              <Row label="Status">
                <DeliveryStatusBadge delivery={detail.data} />
              </Row>
              <Row label="Received">
                <span className="text-xs tabular-nums">
                  {formatUTC(detail.data.receivedAt)}
                </span>
              </Row>
              <Row label="Event">{detail.data.event ?? "—"}</Row>
              <Row label="Delivery ID">
                <span className="font-mono text-xs">{detail.data.id}</span>
              </Row>
              {detail.data.dedupeKey && (
                <Row label="Provider delivery ID">
                  <span className="font-mono text-xs">
                    {detail.data.dedupeKey}
                  </span>
                </Row>
              )}
              <Row label="Attempts">
                <span className="tabular-nums">{detail.data.attempts}</span>
              </Row>
              {detail.data.deliveredAt && (
                <Row label="Delivered">
                  <span className="text-xs tabular-nums">
                    {formatUTC(detail.data.deliveredAt)}
                  </span>
                </Row>
              )}
              {detail.data.claimedBy && (
                <Row label="Claimed by">
                  <span className="font-mono text-xs">
                    {detail.data.claimedBy}
                  </span>
                </Row>
              )}
              {detail.data.replayOfId && (
                <Row label="Replay of">
                  <span className="font-mono text-xs">
                    {detail.data.replayOfId}
                  </span>
                </Row>
              )}
              {/* The reason a consumer rejected this — the whole point of the
                  nack contract, readable without SSH access to the runtime. */}
              {detail.data.lastError && (
                <Row label="Error">
                  <span className="text-destructive text-xs">
                    {detail.data.lastError}
                  </span>
                </Row>
              )}
              {detail.data.renderWarnings.length > 0 && (
                <Row label="Unresolved placeholders">
                  <span className="font-mono text-xs text-amber-600 dark:text-amber-400">
                    {detail.data.renderWarnings.join(", ")}
                  </span>
                </Row>
              )}

              {detail.data.renderedText && (
                <Block label="Rendered text">{detail.data.renderedText}</Block>
              )}
              <Block label="Headers">
                {JSON.stringify(detail.data.headers, null, 2)}
              </Block>
              <Block label="Payload">
                {detail.data.payload === null
                  ? "Not stored — this request failed verification."
                  : JSON.stringify(detail.data.payload, null, 2)}
              </Block>
            </div>
          )
        )}

        <DialogFooter>
          {replayable && delivery && (
            <Button
              variant="outline"
              onClick={() => replay.mutate(delivery.id)}
              loading={replay.isPending}
              disabled={replay.isPending}
            >
              {replay.isPending ? "Replaying..." : "Replay delivery"}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
