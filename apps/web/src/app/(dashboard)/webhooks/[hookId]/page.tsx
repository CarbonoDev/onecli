import { Suspense } from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import {
  configuredAppUrl,
  originFromHeaders,
} from "@onecli/api/lib/app-origin";
import { APP_URL } from "@/lib/env";
import { WebhookDetailContent } from "./_components/webhook-detail-content";

export const metadata: Metadata = {
  title: "Webhook",
};

interface Props {
  params: Promise<{ hookId: string }>;
}

export default async function WebhookDetailPage({ params }: Props) {
  const { hookId } = await params;
  const publicBaseUrl =
    configuredAppUrl() ?? originFromHeaders(await headers()) ?? APP_URL;

  return (
    <div className="flex flex-1 flex-col gap-6">
      <Suspense>
        <WebhookDetailContent hookId={hookId} publicBaseUrl={publicBaseUrl} />
      </Suspense>
    </div>
  );
}
