"use client";

import { useEffect, useState } from "react";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { useUpdateWebhook } from "@/hooks/use-webhooks";
import type { WebhookEndpoint } from "@/lib/api";
import {
  validateWebhookForm,
  WebhookFormFields,
  type WebhookFormValues,
} from "./webhook-form-fields";

export interface EditWebhookDialogProps {
  endpoint: WebhookEndpoint;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const seed = (endpoint: WebhookEndpoint): WebhookFormValues => ({
  name: endpoint.name,
  slug: endpoint.slug,
  agentId: endpoint.agentId,
  verification: endpoint.verification,
  template: endpoint.template,
  routing: endpoint.routing ? JSON.stringify(endpoint.routing, null, 2) : "",
  enabled: endpoint.enabled,
});

export const EditWebhookDialog = ({
  endpoint,
  open,
  onOpenChange,
}: EditWebhookDialogProps) => {
  const [values, setValues] = useState<WebhookFormValues>(() => seed(endpoint));
  const [touched, setTouched] = useState(false);
  const update = useUpdateWebhook();

  // Re-seed on open so a cancelled edit does not persist into the next one.
  useEffect(() => {
    if (open) {
      setValues(seed(endpoint));
      setTouched(false);
    }
  }, [open, endpoint]);

  const errors = validateWebhookForm(values);
  const hasError = Object.values(errors).some(Boolean);
  const verificationChanged = values.verification !== endpoint.verification;

  const handleSave = () => {
    setTouched(true);
    if (hasError || update.isPending) return;

    update.mutate(
      {
        hookId: endpoint.id,
        input: {
          name: values.name.trim(),
          slug: values.slug.trim(),
          agentId: values.agentId,
          verification: values.verification,
          template: values.template,
          routing:
            values.routing.trim() === ""
              ? null
              : (JSON.parse(values.routing) as Record<string, unknown>),
          enabled: values.enabled,
          ...(values.verification === "none"
            ? { acknowledgeUnverified: true }
            : {}),
        },
      },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {endpoint.name}</DialogTitle>
          <DialogDescription>
            Template changes apply to new deliveries, and to any delivery you
            replay.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto">
          <WebhookFormFields
            idPrefix={`edit-webhook-${endpoint.id}`}
            values={values}
            errors={errors}
            touched={touched}
            onChange={(patch) =>
              setValues((current) => ({ ...current, ...patch }))
            }
            showEnabled
          />
          {/* A GitHub HMAC key and a shared token are not interchangeable, so
              the server mints a new secret when this changes. Saying so here
              beats discovering it when the provider starts getting 401s. */}
          {verificationChanged && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Changing verification issues a new secret. Update it at the
              provider immediately, or deliveries will be rejected.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            loading={update.isPending}
            disabled={update.isPending}
          >
            {update.isPending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
