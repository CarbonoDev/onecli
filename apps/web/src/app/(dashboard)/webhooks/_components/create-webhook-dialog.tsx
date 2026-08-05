"use client";

import { useState } from "react";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { useCreateWebhook } from "@/hooks/use-webhooks";
import { usePublicBaseUrl } from "@/hooks/use-public-base-url";
import type { WebhookEndpointWithSecret } from "@/lib/api";
import { IngestUrlPanel } from "./ingest-url-panel";
import {
  validateWebhookForm,
  WebhookFormFields,
  type WebhookFormValues,
} from "./webhook-form-fields";

export interface CreateWebhookDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  publicBaseUrl: string;
}

const EMPTY: WebhookFormValues = {
  name: "",
  slug: "",
  agentId: "",
  verification: "github",
  template: "",
  routing: "",
  enabled: true,
};

export const CreateWebhookDialog = ({
  open,
  onOpenChange,
  publicBaseUrl,
}: CreateWebhookDialogProps) => {
  const [values, setValues] = useState<WebhookFormValues>(EMPTY);
  const [touched, setTouched] = useState(false);
  // Two-step: the form, then the setup panel. The URL and secret are the whole
  // point of creating one, so they get a screen rather than a toast.
  const [created, setCreated] = useState<WebhookEndpointWithSecret | null>(
    null,
  );
  const create = useCreateWebhook();

  const baseUrl = usePublicBaseUrl(publicBaseUrl);
  const errors = validateWebhookForm(values);
  const hasError = Object.values(errors).some(Boolean);

  const handleClose = (next: boolean) => {
    if (!next) {
      setValues(EMPTY);
      setTouched(false);
      setCreated(null);
    }
    onOpenChange(next);
  };

  const handleCreate = () => {
    setTouched(true);
    if (hasError || create.isPending) return;

    create.mutate(
      {
        name: values.name.trim(),
        slug: values.slug.trim(),
        agentId: values.agentId,
        verification: values.verification,
        template: values.template,
        routing:
          values.routing.trim() === ""
            ? null
            : (JSON.parse(values.routing) as Record<string, unknown>),
        ...(values.verification === "none"
          ? { acknowledgeUnverified: true }
          : {}),
      },
      { onSuccess: setCreated },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>{created.name} is ready</DialogTitle>
              <DialogDescription>
                Configure your provider with the URL below. Deliveries appear in
                this endpoint&apos;s log as they arrive.
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-[60vh] overflow-y-auto py-2">
              <IngestUrlPanel
                ingestUrl={`${baseUrl}${created.ingestPath}`}
                verification={created.verification}
                secret={created.secret}
              />
            </div>
            <DialogFooter>
              <Button onClick={() => handleClose(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create webhook endpoint</DialogTitle>
              <DialogDescription>
                OneCLI verifies each delivery, renders your template, and queues
                it for the agent to pick up.
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-[60vh] overflow-y-auto">
              <WebhookFormFields
                idPrefix="create-webhook"
                values={values}
                errors={errors}
                touched={touched}
                onChange={(patch) =>
                  setValues((current) => ({ ...current, ...patch }))
                }
              />
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => handleClose(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleCreate}
                loading={create.isPending}
                disabled={create.isPending}
              >
                {create.isPending ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};
