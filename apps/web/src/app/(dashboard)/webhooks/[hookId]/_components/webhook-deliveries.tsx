"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Radio } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { webhooks } from "@/lib/api";
import type { WebhookDelivery, WebhookDeliveryPage } from "@/lib/api";
import { DeliveriesTable } from "./deliveries-table";
import { DeliveryDetailDialog } from "./delivery-detail-dialog";

export interface WebhookDeliveriesProps {
  hookId: string;
}

/**
 * A port of the activity log's paging + live-poll shape.
 *
 * Plain `useState` rather than `useInfiniteQuery` on purpose: the live poll
 * replaces page 0 in place while keeping appended pages, which does not map
 * cleanly onto infinite-query pages — and the activity log is the design
 * authority for this surface.
 */
export const WebhookDeliveries = ({ hookId }: WebhookDeliveriesProps) => {
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [nextCursor, setNextCursor] =
    useState<WebhookDeliveryPage["nextCursor"]>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [liveMode, setLiveMode] = useState(true);
  const [selected, setSelected] = useState<WebhookDelivery | null>(null);
  const initialized = useRef(false);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    try {
      const page = await webhooks.deliveries(hookId);
      setDeliveries(page.deliveries);
      setNextCursor(page.nextCursor);
      initialized.current = true;
    } finally {
      setLoading(false);
    }
  }, [hookId]);

  useEffect(() => {
    initialized.current = false;
    void loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    if (!liveMode || loading) return;
    const timer = setInterval(async () => {
      if (!initialized.current) return;
      try {
        const page = await webhooks.deliveries(hookId);
        setDeliveries((prev) => {
          // Identity check: an unchanged head means React can skip the render
          // entirely, which matters at a 3s cadence.
          if (
            prev.length === page.deliveries.length &&
            prev[0]?.id === page.deliveries[0]?.id &&
            prev[0]?.status === page.deliveries[0]?.status
          ) {
            return prev;
          }
          return page.deliveries;
        });
        setNextCursor(page.nextCursor);
      } catch {
        // Best-effort polling: a transient failure should not clear the table.
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [liveMode, loading, hookId]);

  const loadMore = async () => {
    if (!nextCursor) return;
    // Paging and live-replacing page 0 fight each other; paging wins.
    setLiveMode(false);
    setLoadingMore(true);
    try {
      const page = await webhooks.deliveries(hookId, {
        cursorCreatedAt: nextCursor.createdAt,
        cursorId: nextCursor.id,
      });
      setDeliveries((prev) => [...prev, ...page.deliveries]);
      setNextCursor(page.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Deliveries</h2>
        <button
          type="button"
          onClick={() => setLiveMode((value) => !value)}
          className="hover:bg-muted flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors"
        >
          <Radio
            className={`size-3.5 ${liveMode ? "animate-pulse text-green-500" : "text-muted-foreground"}`}
          />
          Live
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="text-muted-foreground size-5 animate-spin" />
        </div>
      ) : (
        <>
          <DeliveriesTable
            deliveries={deliveries}
            onRowClick={setSelected}
            emptyMessage="No deliveries yet. Send a test request to see one appear here."
          />
          {nextCursor && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore && <Loader2 className="size-3.5 animate-spin" />}
                Load more
              </Button>
            </div>
          )}
        </>
      )}

      <DeliveryDetailDialog
        delivery={selected}
        hookId={hookId}
        onClose={() => setSelected(null)}
      />
    </div>
  );
};
