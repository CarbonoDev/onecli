"use client";

import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { useWebhooks } from "@/hooks/use-webhooks";
import { WebhooksTable } from "./webhooks-table";

export interface WebhooksContentProps {
  /** Resolved by the RSC page; the origin providers will POST to. */
  publicBaseUrl: string;
}

export const WebhooksContent = ({ publicBaseUrl }: WebhooksContentProps) => {
  const endpoints = useWebhooks();

  if (endpoints.isPending) {
    return (
      <Card className="p-4">
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-10 w-full rounded-md" />
          ))}
        </div>
      </Card>
    );
  }

  if (endpoints.isError) {
    return (
      <Card className="p-6">
        <p className="text-sm font-medium">Could not load webhooks</p>
        <p className="text-muted-foreground mt-1 text-xs">
          {endpoints.error.message}
        </p>
      </Card>
    );
  }

  return (
    <WebhooksTable
      endpoints={endpoints.data ?? []}
      publicBaseUrl={publicBaseUrl}
    />
  );
};
