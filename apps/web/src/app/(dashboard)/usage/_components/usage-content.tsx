"use client";

import { BarChart3, Lock, TriangleAlert } from "lucide-react";
import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { ApiError } from "@/lib/api";
import { useUsage } from "@/hooks/use-usage";
import { formatPeriod } from "./format";
import { RecordedRequestsInfo } from "./recorded-requests-info";
import { UsageStatCard } from "./usage-stat-card";
import { UsageByAgentTable } from "./usage-by-agent-table";

const StatSkeleton = () => (
  <Card className="gap-0 p-6">
    <Skeleton className="h-4 w-32" />
    <Skeleton className="mt-4 h-8 w-24" />
    <Skeleton className="mt-2 h-3 w-40" />
  </Card>
);

export const UsageContent = () => {
  const usage = useUsage();

  if (usage.isPending) {
    return (
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <StatSkeleton />
          <StatSkeleton />
        </div>
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  if (usage.isError || !usage.data) {
    // `retry: false` means a 500 and a dropped connection land here too, not
    // just the 403 a project-scoped credential earns. Naming the auth cause
    // unconditionally would misdiagnose a transport blip as a permissions
    // problem, so only a real 403 gets the auth wording (and the lock).
    const forbidden =
      usage.error instanceof ApiError && usage.error.status === 403;
    return forbidden ? (
      <EmptyState
        icon={Lock}
        title="Usage is unavailable"
        description="Usage needs an organization-scoped session. Switch organizations or sign in again to view it."
      />
    ) : (
      <EmptyState
        icon={TriangleAlert}
        title="Couldn't load usage"
        description="Something went wrong fetching usage. Reload the page to try again."
      />
    );
  }

  const { periodStart, periodEnd, requests, integrationCalls, agents } =
    usage.data;
  const period = formatPeriod(periodStart, periodEnd);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        {/* "recorded gateway requests", NOT "total gateway requests". The
            gateway only writes a row when it injected a credential or made a
            non-plain-allow decision, so a pass-through on an agent's own key is
            never counted — the total is not computable and claiming it would be
            a lie. `RecordedRequestsInfo` states the gap. */}
        <UsageStatCard
          title="Requests this period"
          period={period}
          value={requests}
          caption="recorded gateway requests"
          titleAdornment={<RecordedRequestsInfo />}
        />
        {/* Exact, and needs no caveat: injection is precisely the condition
            that guarantees the row exists. */}
        <UsageStatCard
          title="Integration calls"
          period={period}
          value={integrationCalls}
          caption="requests with credential injection"
        />
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-medium">Usage by agent</h2>
        {agents.length === 0 ? (
          <EmptyState
            variant="dashed"
            things="recorded requests"
            icon={BarChart3}
            description="Run an agent through the gateway to see its usage here."
          />
        ) : (
          <UsageByAgentTable agents={agents} totalRequests={requests} />
        )}
      </div>
    </div>
  );
};
