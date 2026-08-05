"use client";

import { Card } from "@onecli/ui/components/card";
import type { WebhookEndpointWithSecret } from "@/lib/api";
import { IngestUrlPanel } from "../../_components/ingest-url-panel";

export interface WebhookSummaryCardProps {
  endpoint: WebhookEndpointWithSecret;
  ingestUrl: string;
}

const Field = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <div className="space-y-1">
    <p className="text-muted-foreground text-xs font-medium">{label}</p>
    <div className="text-sm">{children}</div>
  </div>
);

export const WebhookSummaryCard = ({
  endpoint,
  ingestUrl,
}: WebhookSummaryCardProps) => (
  <div className="grid gap-4 lg:grid-cols-2">
    <Card className="p-6">
      <IngestUrlPanel
        ingestUrl={ingestUrl}
        verification={endpoint.verification}
        secret={endpoint.secret}
      />
    </Card>

    <Card className="space-y-4 p-6">
      <Field label="Agent">
        {endpoint.agentName}{" "}
        <span className="text-muted-foreground font-mono text-xs">
          {endpoint.agentIdentifier}
        </span>
      </Field>

      <Field label="Template">
        <pre className="bg-muted max-h-32 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap">
          {endpoint.template.trim() === ""
            ? "(default: the slug, the event, and the raw payload)"
            : endpoint.template}
        </pre>
      </Field>

      <Field label="Routing">
        {endpoint.routing ? (
          <pre className="bg-muted max-h-32 overflow-auto rounded-md p-3 font-mono text-xs">
            {JSON.stringify(endpoint.routing, null, 2)}
          </pre>
        ) : (
          <span className="text-muted-foreground text-xs">
            None — the consumer decides what to do with each delivery.
          </span>
        )}
      </Field>

      <Field label="Rate limit">
        <span className="text-muted-foreground text-xs">
          {endpoint.rateLimitPerMin} requests per minute
        </span>
      </Field>
    </Card>
  </div>
);
