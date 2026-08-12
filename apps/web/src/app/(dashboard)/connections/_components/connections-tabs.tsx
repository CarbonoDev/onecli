"use client";

import { useMemo, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppMessages } from "@/hooks/use-app-connected";
import { connectionsPath } from "@/lib/navigation";
import {
  AnimatedTabs,
  AnimatedTabList,
  AnimatedTabTrigger,
} from "@onecli/ui/components/animated-tabs";
import { Badge } from "@onecli/ui/components/badge";
import { apiGet, secretsPath, type PageScope } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { useConnections, useVaultConnections } from "@/hooks/use-connections";
import { activeTabFor, isConnectionsTab, tabRoutesFor } from "./tab-routes";

interface ConnectionsTabsProps {
  getSecrets?: () => Promise<unknown[]>;
  showVaults?: boolean;
  /**
   * Spend budgets are per-project. The org page passes `false`; there is no
   * organization budget surface to route to.
   */
  showBudgets?: boolean;
  /**
   * Whether the `Connected` tab carries an inventory count. The count sums
   * project-only inventory and costs two admin-gated reads at org scope, so the
   * org page passes `false` and both queries are skipped rather than 403ing on
   * every page load for a member.
   */
  showConnectedCount?: boolean;
  basePath?: string;
  pageScope?: PageScope;
}

export const ConnectionsTabs = ({
  getSecrets,
  showVaults = true,
  showBudgets = true,
  showConnectedCount = true,
  basePath,
  pageScope = "project",
}: ConnectionsTabsProps) => {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const activeTab = activeTabFor(pathname, basePath);
  const tabRoutes = tabRoutesFor(pathname, basePath);
  const [, startTransition] = useTransition();

  const { data: connectionsList = [] } = useConnections(
    pageScope,
    showConnectedCount,
  );
  const { data: secretsList = [] } = useQuery({
    queryKey: queryKeys.secrets.list(pageScope),
    queryFn: getSecrets ?? (() => apiGet<unknown[]>(secretsPath(pageScope))),
    enabled: showConnectedCount,
  });
  const { data: vaultsList = [] } = useVaultConnections(
    showVaults && pageScope === "project",
  );

  const connectedCount = useMemo(() => {
    const appCount = connectionsList.filter(
      (c) => c.status === "connected",
    ).length;
    return appCount + secretsList.length + (showVaults ? vaultsList.length : 0);
  }, [connectionsList, secretsList, vaultsList, showVaults]);

  useAppMessages({
    onConnected: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.connections.all() });
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.all() });
    },
    onConfigure: (provider) =>
      router.push(connectionsPath({ pathname, basePath }, `/apps/${provider}`)),
  });

  // `AnimatedTabs` hands back a bare string, so narrow before indexing — an
  // unknown value is ignored rather than routed to `undefined`.
  const handleTabChange = (value: string) => {
    if (!isConnectionsTab(value)) return;
    startTransition(() => router.push(tabRoutes[value]));
  };

  return (
    <AnimatedTabs value={activeTab} onValueChange={handleTabChange}>
      <AnimatedTabList className="sm:justify-between">
        <div className="flex">
          <AnimatedTabTrigger value="apps">Apps</AnimatedTabTrigger>
          <AnimatedTabTrigger value="custom">Custom</AnimatedTabTrigger>
          <AnimatedTabTrigger value="llms">LLMs</AnimatedTabTrigger>
          {showBudgets && (
            <AnimatedTabTrigger value="budgets">Budgets</AnimatedTabTrigger>
          )}
          {showVaults && (
            <AnimatedTabTrigger value="vaults">
              <span className="sm:hidden">Vaults</span>
              <span className="hidden sm:inline">External Vaults</span>
            </AnimatedTabTrigger>
          )}
        </div>
        <AnimatedTabTrigger
          value="connected"
          className="flex items-center gap-2"
        >
          Connected
          {showConnectedCount && connectedCount > 0 && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              {connectedCount}
            </Badge>
          )}
        </AnimatedTabTrigger>
      </AnimatedTabList>
    </AnimatedTabs>
  );
};
