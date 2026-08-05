"use client";

import { usePathname, useRouter } from "next/navigation";
import { Badge } from "@onecli/ui/components/badge";
import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { PageHeader } from "@dashboard/page-header";
import { useWebhook } from "@/hooks/use-webhooks";
import { usePublicBaseUrl } from "@/hooks/use-public-base-url";
import { withProjectPrefix } from "@/lib/navigation";
import { WebhookRowActions } from "../../_components/webhook-row-actions";
import { WebhookDeliveries } from "./webhook-deliveries";
import { WebhookSummaryCard } from "./webhook-summary-card";

export interface WebhookDetailContentProps {
  hookId: string;
  publicBaseUrl: string;
}

export const WebhookDetailContent = ({
  hookId,
  publicBaseUrl,
}: WebhookDetailContentProps) => {
  const endpoint = useWebhook(hookId);
  const baseUrl = usePublicBaseUrl(publicBaseUrl);
  const router = useRouter();
  const pathname = usePathname();

  if (endpoint.isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-7 w-48" />
        <Card className="p-6">
          <Skeleton className="h-24 w-full" />
        </Card>
      </div>
    );
  }

  if (endpoint.isError) {
    return (
      <Card className="p-6">
        <p className="text-sm font-medium">Webhook not found</p>
        <p className="text-muted-foreground mt-1 text-xs">
          {endpoint.error.message}
        </p>
      </Card>
    );
  }

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <PageHeader
          title={endpoint.data.name}
          description={`Deliveries wake ${endpoint.data.agentName}. "Delivered" means the runtime accepted it, not that the agent acted.`}
        />
        <div className="flex items-center gap-2">
          {!endpoint.data.enabled && <Badge variant="outline">Disabled</Badge>}
          <WebhookRowActions
            endpoint={endpoint.data}
            onDeleted={() =>
              router.push(withProjectPrefix(pathname, "/webhooks"))
            }
          />
        </div>
      </div>

      <WebhookSummaryCard
        endpoint={endpoint.data}
        ingestUrl={`${baseUrl}${endpoint.data.ingestPath}`}
      />

      <WebhookDeliveries hookId={hookId} />
    </>
  );
};
