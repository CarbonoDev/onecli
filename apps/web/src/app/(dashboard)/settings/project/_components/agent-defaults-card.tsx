"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Switch } from "@onecli/ui/components/switch";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { useConnections } from "@/hooks/use-connections";
import {
  useAgentDefaults,
  useSetAgentDefault,
  useRemoveAgentDefault,
} from "@/hooks/use-agent-defaults";

export interface AgentDefaultsCardProps {
  canManage: boolean;
}

/**
 * Which connections a brand-new agent in this project is granted
 * automatically, applied once at creation (`afterCreateAgent`, server-side —
 * see `agent-default-connections-service.ts`). Deliberately whole-connection
 * ("full") toggles only, not the per-tool custom picker the agent grants
 * dialog offers: the ask this answers is "a new agent shouldn't be born with
 * zero access", not fine-grained default scoping — an operator who wants a
 * narrower default can still attach the connection manually with custom
 * access after the agent exists. Every connection in the project's pool is
 * listed, off by default; there is deliberately no "select all" — an explicit
 * per-connection opt-in is the point, not a shortcut around it.
 */
export const AgentDefaultsCard = ({ canManage }: AgentDefaultsCardProps) => {
  const connections = useConnections();
  const defaults = useAgentDefaults();
  const setDefault = useSetAgentDefault();
  const removeDefault = useRemoveAgentDefault();

  const isPending = connections.isPending || defaults.isPending;

  const defaultConnectionIds = new Set(
    (defaults.data ?? []).map((d) => d.connectionId),
  );

  const toggle = (connectionId: string, next: boolean) => {
    if (next) {
      setDefault.mutate({
        connectionId,
        input: { access: "full", resources: null },
      });
    } else {
      removeDefault.mutate(connectionId);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Default connections for new agents</CardTitle>
        <CardDescription>
          A brand-new agent in this project starts with these connections
          already attached, instead of zero access until someone attaches them
          by hand.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isPending && (
          <div className="space-y-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        )}
        {!isPending && (connections.data ?? []).length === 0 && (
          <p className="text-muted-foreground text-sm">
            Connect an app first — there&apos;s nothing to default a new agent
            to yet.
          </p>
        )}
        {!isPending &&
          (connections.data ?? []).map((conn) => (
            <div
              key={conn.id}
              className="flex items-center justify-between rounded-md border px-3 py-2"
            >
              <div>
                <p className="text-sm font-medium">
                  {conn.label ?? conn.provider}
                </p>
                <p className="text-muted-foreground text-xs">
                  {conn.provider}
                  {conn.scope === "organization" ? " · org-shared" : ""}
                </p>
              </div>
              <Switch
                checked={defaultConnectionIds.has(conn.id)}
                disabled={
                  !canManage || setDefault.isPending || removeDefault.isPending
                }
                onCheckedChange={(checked) => toggle(conn.id, checked)}
              />
            </div>
          ))}
      </CardContent>
    </Card>
  );
};
