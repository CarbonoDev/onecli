import {
  CircleCheck,
  CircleX,
  Clock,
  Inbox,
  Loader2,
  ShieldX,
} from "lucide-react";
import type { WebhookDelivery } from "@/lib/api";

export interface DeliveryStatusBadgeProps {
  delivery: Pick<WebhookDelivery, "status" | "discardReason" | "inFlight">;
}

/**
 * Same idiom as the activity log's `StatusBadge` — a span plus a lucide icon,
 * not the `Badge` component.
 *
 * "In flight" is not a stored status: the server derives it from a pending row
 * that holds a live claim, which is why it is checked before `status` here.
 */
export const DeliveryStatusBadge = ({ delivery }: DeliveryStatusBadgeProps) => {
  if (delivery.inFlight) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-400">
        <Loader2 className="size-3 shrink-0 animate-spin" />
        In flight
      </span>
    );
  }

  if (delivery.status === "delivered") {
    return (
      <span className="text-brand inline-flex items-center gap-1 text-xs font-medium">
        <CircleCheck className="size-3 shrink-0" />
        Delivered
      </span>
    );
  }

  if (delivery.status === "failed") {
    return (
      <span className="text-destructive inline-flex items-center gap-1 text-xs font-medium">
        <CircleX className="size-3 shrink-0" />
        Failed
      </span>
    );
  }

  if (delivery.status === "discarded") {
    if (delivery.discardReason === "rejected") {
      return (
        <span className="text-destructive inline-flex items-center gap-1 text-xs font-medium">
          <ShieldX className="size-3 shrink-0" />
          Rejected
        </span>
      );
    }
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1 text-xs font-medium">
        <Inbox className="size-3 shrink-0" />
        {delivery.discardReason === "handshake" ? "Handshake" : "Ignored"}
      </span>
    );
  }

  return (
    <span className="text-muted-foreground inline-flex items-center gap-1 text-xs font-medium">
      <Clock className="size-3 shrink-0" />
      Queued
    </span>
  );
};
