"use client";

import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { useGroups } from "@/hooks/use-groups";
import { AdminOnlyNotice } from "./admin-only-notice";
import { LocalModeNotice } from "./local-mode-notice";
import { GroupsTable } from "./groups-table";

export interface GroupsContentProps {
  /** Threaded from the RSC page (server-only auth mode); false = local mode. */
  groupsEnabled: boolean;
}

export const GroupsContent = ({ groupsEnabled }: GroupsContentProps) => {
  // The groups query's 403 is the admin authority (the /team D-K pattern): a
  // non-admin gets a deterministic error and the surface renders the
  // admin-only notice — the API gates the whole router on admin anyway.
  const groups = useGroups(groupsEnabled);

  // Local mode has a single built-in identity, so groups are inert — return
  // before the query's pending/error branches so no doomed request fires
  // against an unreachable org backend (matches TeamContent's ordering).
  if (!groupsEnabled) return <LocalModeNotice />;

  if (groups.isPending) {
    return (
      <div className="space-y-4">
        {[1, 2].map((i) => (
          <Card key={i} className="p-6">
            <div className="flex items-center justify-between">
              <div className="space-y-2">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-4 w-48" />
              </div>
              <Skeleton className="size-8 rounded-md" />
            </div>
          </Card>
        ))}
      </div>
    );
  }

  if (groups.isError) return <AdminOnlyNotice />;

  return <GroupsTable groups={groups.data ?? []} />;
};
