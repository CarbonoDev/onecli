import { Suspense } from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { PageHeader } from "@dashboard/page-header";
import {
  configuredAppUrl,
  originFromHeaders,
} from "@onecli/api/lib/app-origin";
import { APP_URL } from "@/lib/env";
import { WebhooksContent } from "./_components/webhooks-content";

export const metadata: Metadata = {
  title: "Webhooks",
};

export default async function WebhooksPage() {
  // Resolved server-side and threaded down: this origin is what gets pasted
  // into a provider's config, so an explicitly configured APP_URL must win over
  // anything the browser can infer. (Same chain as /settings/instance.)
  const publicBaseUrl =
    configuredAppUrl() ?? originFromHeaders(await headers()) ?? APP_URL;

  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Webhooks"
        description="Give GitHub, alerting, or any HTTP sender a URL that wakes an agent."
      />
      <Suspense>
        <WebhooksContent publicBaseUrl={publicBaseUrl} />
      </Suspense>
    </div>
  );
}
