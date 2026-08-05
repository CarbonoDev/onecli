"use client";

import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import { Switch } from "@onecli/ui/components/switch";
import { Textarea } from "@onecli/ui/components/textarea";
import { cn } from "@onecli/ui/lib/utils";
import { useAgents } from "@/hooks/use-agents";
import { useWebhookVerifiers } from "@/hooks/use-webhooks";

export interface WebhookFormValues {
  name: string;
  slug: string;
  agentId: string;
  verification: string;
  template: string;
  routing: string;
  enabled: boolean;
}

export interface WebhookFormErrors {
  name?: string | null;
  slug?: string | null;
  agentId?: string | null;
  routing?: string | null;
}

export interface WebhookFormFieldsProps {
  values: WebhookFormValues;
  errors: WebhookFormErrors;
  touched: boolean;
  onChange: (patch: Partial<WebhookFormValues>) => void;
  /** The enabled switch only makes sense once an endpoint exists. */
  showEnabled?: boolean;
  idPrefix: string;
}

/**
 * Validation lives here as plain predicates rather than a resolver — this app
 * has no react-hook-form and no zodResolver, and the server's Zod schema is the
 * authority regardless. These checks exist to avoid a round trip, not to be the
 * gate.
 */
export const validateWebhookForm = (
  values: WebhookFormValues,
): WebhookFormErrors => ({
  name:
    values.name.trim().length === 0
      ? "Name is required."
      : values.name.trim().length > 100
        ? "Name must be 100 characters or fewer."
        : null,
  slug: !/^[a-z0-9][a-z0-9-]*$/.test(values.slug.trim())
    ? "Lowercase letters, digits and dashes only."
    : null,
  agentId: values.agentId === "" ? "Choose the agent to wake." : null,
  routing: routingError(values.routing),
});

/**
 * The routing blob is checked for being parseable JSON and nothing else.
 * OneCLI never interprets it — validating its shape here would quietly couple
 * the dashboard to one consumer's schema.
 */
const routingError = (routing: string): string | null => {
  if (routing.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(routing);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return "Routing must be a JSON object.";
    }
    return null;
  } catch {
    return "Routing must be valid JSON.";
  }
};

export const WebhookFormFields = ({
  values,
  errors,
  touched,
  onChange,
  showEnabled = false,
  idPrefix,
}: WebhookFormFieldsProps) => {
  const agents = useAgents();
  const verifiers = useWebhookVerifiers();
  const show = (error?: string | null) => touched && Boolean(error);

  return (
    <div className="space-y-4 py-2">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-name`}>Name</Label>
        <Input
          id={`${idPrefix}-name`}
          placeholder="e.g. GitHub issues"
          value={values.name}
          onChange={(e) => onChange({ name: e.target.value })}
          autoFocus
          className={cn(show(errors.name) && "border-destructive")}
        />
        {show(errors.name) && (
          <p className="text-destructive text-xs">{errors.name}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-slug`}>Slug</Label>
        <Input
          id={`${idPrefix}-slug`}
          placeholder="gh-issues"
          value={values.slug}
          onChange={(e) => onChange({ slug: e.target.value })}
          className={cn("font-mono", show(errors.slug) && "border-destructive")}
        />
        <p className="text-muted-foreground text-xs">
          Identifies the webhook to the agent, and available in templates as{" "}
          <code className="font-mono">{"{{$slug}}"}</code>.
        </p>
        {show(errors.slug) && (
          <p className="text-destructive text-xs">{errors.slug}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-verification`}>Verification</Label>
        <Select
          value={values.verification}
          onValueChange={(verification) => onChange({ verification })}
        >
          <SelectTrigger id={`${idPrefix}-verification`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(verifiers.data ?? []).map((verifier) => (
              <SelectItem key={verifier.id} value={verifier.id}>
                {verifier.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {values.verification === "none" && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Anyone who learns this URL can trigger the agent. Treat it like a
            password and prefer a signed or token-verified sender.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-agent`}>Agent to wake</Label>
        <Select
          value={values.agentId}
          onValueChange={(agentId) => onChange({ agentId })}
        >
          <SelectTrigger
            id={`${idPrefix}-agent`}
            className={cn(
              "w-full",
              show(errors.agentId) && "border-destructive",
            )}
          >
            <SelectValue placeholder="Select an agent" />
          </SelectTrigger>
          <SelectContent>
            {agents.isPending ? (
              <SelectItem value="__loading" disabled>
                Loading agents...
              </SelectItem>
            ) : (agents.data ?? []).length === 0 ? (
              <SelectItem value="__empty" disabled>
                No agents yet
              </SelectItem>
            ) : (
              (agents.data ?? []).map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
        {show(errors.agentId) && (
          <p className="text-destructive text-xs">{errors.agentId}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-template`}>Message template</Label>
        <Textarea
          id={`${idPrefix}-template`}
          rows={4}
          value={values.template}
          onChange={(e) => onChange({ template: e.target.value })}
          placeholder="{{action}} on {{repository.full_name}}"
          className="font-mono text-xs"
        />
        <p className="text-muted-foreground text-xs">
          <code className="font-mono">{"{{a.b.0.c}}"}</code> reads the payload;{" "}
          <code className="font-mono">{"{{$raw}}"}</code>,{" "}
          <code className="font-mono">{"{{$event}}"}</code>,{" "}
          <code className="font-mono">{"{{$slug}}"}</code> and{" "}
          <code className="font-mono">{"{{$delivery_id}}"}</code> are built in.
          Leave blank for the default.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-routing`}>Routing (optional)</Label>
        <Textarea
          id={`${idPrefix}-routing`}
          rows={4}
          value={values.routing}
          onChange={(e) => onChange({ routing: e.target.value })}
          placeholder={'{ "mode": "lane", "target": { "lane": "triage" } }'}
          className={cn(
            "font-mono text-xs",
            show(errors.routing) && "border-destructive",
          )}
        />
        <p className="text-muted-foreground text-xs">
          Passed to the agent runtime untouched — OneCLI never reads it. Consult
          your runtime&apos;s docs for the shape it expects.
        </p>
        {show(errors.routing) && (
          <p className="text-destructive text-xs">{errors.routing}</p>
        )}
      </div>

      {showEnabled && (
        <div className="flex items-center justify-between rounded-md border px-3 py-2">
          <div>
            <Label htmlFor={`${idPrefix}-enabled`}>Enabled</Label>
            <p className="text-muted-foreground mt-0.5 text-xs">
              While disabled, deliveries are dropped and the sender still sees a
              success — so the provider will not disable the hook on its side.
            </p>
          </div>
          <Switch
            id={`${idPrefix}-enabled`}
            checked={values.enabled}
            onCheckedChange={(enabled) => onChange({ enabled })}
          />
        </div>
      )}
    </div>
  );
};
