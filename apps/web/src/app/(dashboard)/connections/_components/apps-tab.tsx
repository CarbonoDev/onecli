"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  PROJECT_PATH_RE,
  ORG_PATH_RE,
  connectionsPath,
} from "@/lib/navigation";
import { ChevronRight, Search, X } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { cn } from "@onecli/ui/lib/utils";
import {
  APP_CATEGORIES,
  CATEGORY_LABELS,
  type AppCategory,
} from "./app-categories";
import type { AppDefinition } from "@onecli/api/apps/types";
import { useQueryClient } from "@tanstack/react-query";
import type { PageScope } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { useConnections } from "@/hooks/use-connections";
import {
  useConfiguredProviders,
  useEnvDefaultProviders,
} from "@/hooks/use-app-config";
import { useAvailableApps } from "@/hooks/use-available-apps";
import { getApps, getApp } from "@onecli/api/apps/registry";
import { RequestAppSlot } from "@/lib/components/request-app-slot";
import {
  useAppMessages,
  type AppConnectedEvent,
} from "@/hooks/use-app-connected";
import { ProAppDialog } from "@/lib/components/pro-app-dialog";
import { UnavailableBadge } from "@/lib/components/unavailable-badge";
import { AppIcon } from "./app-icon";
import { ConnectAppDialog } from "./connect-app-dialog";
import { ConfigureCredentialsDialog } from "./configure-credentials-dialog";
import { useConnectParam } from "./use-connect-param";

/**
 * Whether choosing this app's connect action depends on the configured/env-default
 * credential sets. Only an unconnected app that carries its own credential fields
 * can be routed to `ConfigureCredentialsDialog`; everything else goes straight to
 * the OAuth popup regardless of what those two queries return. Single source of
 * truth for both `handleConnect`'s branch and the disabled gate on its controls —
 * if they drifted, a control could stay enabled while its outcome was still unknown.
 */
const needsCredentialData = (app: AppDefinition, connectionCount: number) =>
  Boolean(app.configurable?.fields) && connectionCount === 0;

interface AppsTabProps {
  pageScope?: PageScope;
  basePath?: string;
  /**
   * Connect-only surface (onprem-slim): the per-app detail pages don't exist, so the
   * row connects directly and "View details" / post-connect navigation are suppressed.
   */
  connectOnly?: boolean;
}

export const AppsTab = ({
  pageScope = "project",
  basePath,
  connectOnly = false,
}: AppsTabProps) => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const searchQuery = searchParams.get("q") ?? "";
  const [localSearch, setLocalSearch] = useState(searchQuery);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Intercept Ctrl/Cmd+F on the apps page to focus the search field instead of
  // the browser's native find. Mirrors the window keydown + cleanup pattern
  // used in the dashboard header.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only the bare Ctrl/Cmd+F chord triggers the browser's native find;
      // Shift/Alt variants mean other things, so don't hijack them.
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "f"
      ) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
  const activeCategory =
    (searchParams.get("category") as AppCategory | null) ?? "all";
  const [configApp, setConfigApp] = useState<AppDefinition | null>(null);
  const [connectApp, setConnectApp] = useState<AppDefinition | null>(null);
  const [connectAgentName, setConnectAgentName] = useState<
    string | undefined
  >();
  const [premiumApp, setProApp] = useState<AppDefinition | null>(null);
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestHostname, setRequestHostname] = useState("");
  const [requestAppName, setRequestAppName] = useState<string | undefined>();

  const updateParam = useCallback(
    (key: string, value: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) params.set(key, value);
      else params.delete(key);
      const qs = params.toString();
      startTransition(() => {
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
      });
    },
    [searchParams, router, pathname, startTransition],
  );

  const queryClient = useQueryClient();
  const connectionsQuery = useConnections(pageScope);
  const configuredQuery = useConfiguredProviders(pageScope);
  const envDefaultsQuery = useEnvDefaultProviders();
  const availableQuery = useAvailableApps(pageScope);

  const connectionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of (connectionsQuery.data ?? []).filter(
      (c) => c.status === "connected",
    )) {
      counts.set(c.provider, (counts.get(c.provider) ?? 0) + 1);
    }
    return counts;
  }, [connectionsQuery.data]);
  const configuredProviders = useMemo(
    () => new Set(configuredQuery.data ?? []),
    [configuredQuery.data],
  );
  const envDefaultProviders = useMemo(
    () => new Set(envDefaultsQuery.data ?? []),
    [envDefaultsQuery.data],
  );
  // The grid only needs connections: an app's name, icon and connected/count
  // state all come from `connectionsQuery`. Gating it on the credential queries
  // too made every card sit behind a skeleton for the slowest of the three.
  const gridLoading = connectionsQuery.isPending;
  // ...but the *connect action* still needs both credential sets to pick between
  // the credentials dialog and the OAuth popup. Until these settle both sets are
  // empty, which would send an already-configured app to the wrong dialog, so
  // every control whose outcome depends on them stays disabled.
  const credentialsPending =
    configuredQuery.isPending || envDefaultsQuery.isPending;

  const handleConnected = useCallback(
    ({ provider, connectionId }: AppConnectedEvent) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.connections.all() });
      // A credentials-import connect can implicitly save an app config.
      queryClient.invalidateQueries({
        queryKey: queryKeys.appConfig.configured(pageScope),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.counts.all() });
      if (provider && !connectOnly) {
        const path = connectionsPath(
          { pathname, basePath },
          `/apps/${provider}`,
        );
        // Hand a brand-new account to the detail page so it can offer agent
        // access on arrival — the popup's message is long gone by the time
        // that page mounts. A reconnect carries no id and just navigates.
        router.push(
          connectionId
            ? `${path}?connected=${encodeURIComponent(connectionId)}`
            : path,
        );
      }
    },
    [queryClient, pageScope, router, basePath, pathname, connectOnly],
  );

  useAppMessages({
    onConnected: handleConnected,
    onConfigure: (provider) => {
      // Connect-only has no detail page — open the config dialog in place instead.
      if (connectOnly) {
        setConfigApp(getApp(provider) ?? null);
        return;
      }
      router.push(connectionsPath({ pathname, basePath }, `/apps/${provider}`));
    },
  });

  const openConnectPopup = (
    provider: string,
    options?: { agentName?: string; height?: number },
  ) => {
    const w = 520;
    const h = options?.height ?? 700;
    const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - h) / 2);
    const searchParams = new URLSearchParams();
    if (options?.agentName) searchParams.set("agent_name", options.agentName);
    const projectMatch = pathname.match(PROJECT_PATH_RE)?.[1];
    if (projectMatch) searchParams.set("projectId", projectMatch);
    if (pageScope === "organization") {
      const orgMatch = pathname.match(ORG_PATH_RE)?.[1];
      if (orgMatch) searchParams.set("orgId", orgMatch);
    }
    const qs = searchParams.toString();
    window.open(
      `/app-connect/${provider}${qs ? `?${qs}` : ""}`,
      `connect-${provider}`,
      `width=${w},height=${h},left=${left},top=${top},scrollbars=yes,resizable=yes`,
    );
  };

  // Derived set for backward-compat with useConnectParam
  const connectedProviders = useMemo(
    () =>
      new Set(
        [...connectionCounts.entries()]
          .filter(([, count]) => count > 0)
          .map(([provider]) => provider),
      ),
    [connectionCounts],
  );

  // Handle ?connect=<provider> and ?request=<hostname> URL params. This branches
  // on the credential sets exactly like `handleConnect`, so it must keep waiting
  // on all three queries — only the grid render was unblocked.
  useConnectParam({
    loading: gridLoading || credentialsPending,
    connectedProviders,
    configuredProviders,
    envDefaultProviders,
    onConnect: useCallback((app: AppDefinition, agentName?: string) => {
      setConnectApp(app);
      setConnectAgentName(agentName);
    }, []),
    onConfigure: setConfigApp,
    onRequestApp: useCallback((hostname: string, appName?: string) => {
      setRequestHostname(hostname);
      setRequestAppName(appName);
      setRequestOpen(true);
    }, []),
  });

  const availableApps = availableQuery.data;
  const filteredApps = useMemo(() => {
    let apps = [...getApps()].sort((a, b) => {
      const aConnected = (connectionCounts.get(a.id) ?? 0) > 0 ? 1 : 0;
      const bConnected = (connectionCounts.get(b.id) ?? 0) > 0 ? 1 : 0;
      return bConnected - aConnected;
    });

    // Availability (policy-engine step 7): when the org restricts availability,
    // hide the apps this project may not connect. `restricted:false` (an "open"
    // org, or OSS) leaves the picker unfiltered — no behavior change.
    if (availableApps?.restricted) {
      const allowed = new Set(availableApps.providers);
      apps = apps.filter((app) => allowed.has(app.id));
    }

    if (activeCategory !== "all") {
      apps = apps.filter((app) => APP_CATEGORIES[app.id] === activeCategory);
    }

    if (localSearch.trim()) {
      const q = localSearch.toLowerCase();
      apps = apps.filter((app) => app.name.toLowerCase().includes(q));
    }

    return apps;
  }, [connectionCounts, activeCategory, localSearch, availableApps]);

  const hasActiveFilter = localSearch.trim() !== "" || activeCategory !== "all";

  const handleConnect = (
    e: React.MouseEvent | undefined,
    app: AppDefinition,
  ) => {
    e?.stopPropagation();
    const hasCredentials =
      envDefaultProviders.has(app.id) || configuredProviders.has(app.id);
    if (
      needsCredentialData(app, connectionCounts.get(app.id) ?? 0) &&
      !hasCredentials
    ) {
      setConfigApp(app);
      return;
    }
    const popupHeight =
      app.connectionMethod.type === "credentials_import" ? 820 : undefined;
    openConnectPopup(app.id, { height: popupHeight });
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <div className="flex flex-1 flex-wrap gap-1.5">
          {CATEGORY_LABELS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => updateParam("category", id === "all" ? null : id)}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
                activeCategory === id
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-muted-foreground hover:border-foreground/50 hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="relative shrink-0">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            ref={searchInputRef}
            placeholder="Search..."
            value={localSearch}
            onChange={(e) => {
              setLocalSearch(e.target.value);
              updateParam("q", e.target.value || null);
            }}
            className="h-9 w-52 bg-card pl-9 text-sm"
          />
          {localSearch && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setLocalSearch("");
                updateParam("q", null);
              }}
              className="text-muted-foreground hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2 transition-colors"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {!hasActiveFilter && (
          <RequestAppSlot
            requestOpen={requestOpen}
            onRequestOpenChange={setRequestOpen}
            initialName={requestAppName}
            initialUrl={requestHostname}
          />
        )}
        {gridLoading ? (
          Array.from({ length: 12 }, (_, i) => (
            <div
              key={i}
              className="flex items-center justify-between rounded-xl border bg-card px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <Skeleton className="size-9 rounded-lg" />
                <Skeleton className="h-4 w-24 rounded" />
              </div>
              <Skeleton className="h-7 w-16 rounded-md" />
            </div>
          ))
        ) : filteredApps.length === 0 ? (
          <div className="col-span-full flex flex-col items-center justify-center py-12 text-center">
            <p className="text-muted-foreground text-sm">
              No apps match your search.
            </p>
            <button
              type="button"
              onClick={() => {
                setLocalSearch("");
                const params = new URLSearchParams(searchParams.toString());
                params.delete("q");
                params.delete("category");
                const qs = params.toString();
                startTransition(() => {
                  router.replace(qs ? `${pathname}?${qs}` : pathname, {
                    scroll: false,
                  });
                });
              }}
              className="text-brand mt-2 text-sm font-medium hover:underline"
            >
              Clear filters
            </button>
          </div>
        ) : (
          filteredApps.map((app) => {
            const count = connectionCounts.get(app.id) ?? 0;
            const isLocked = !app.available;
            // Connecting this app can't be decided yet — hold its controls.
            const connectPending =
              credentialsPending && needsCredentialData(app, count);
            // In connect-only mode the whole row is a connect control, so it is
            // held too; elsewhere the row just navigates and stays clickable.
            const handleRowClick = isLocked
              ? () => setProApp(app)
              : connectOnly
                ? connectPending
                  ? undefined
                  : () => handleConnect(undefined, app)
                : () =>
                    router.push(
                      connectionsPath(
                        { pathname, basePath },
                        `/apps/${app.id}`,
                      ),
                    );
            return (
              <AppRow
                key={app.id}
                name={app.name}
                icon={app.icon}
                darkIcon={app.darkIcon}
                connectionCount={count}
                cloudOnly={isLocked}
                hideDetails={connectOnly}
                connectPending={connectPending}
                onConnect={(e) => handleConnect(e, app)}
                onClick={handleRowClick}
              />
            );
          })
        )}
      </div>

      {connectApp && (
        <ConnectAppDialog
          appName={connectApp.name}
          appIcon={connectApp.icon}
          appDarkIcon={connectApp.darkIcon}
          agentName={connectAgentName}
          open={!!connectApp}
          onOpenChange={(open) => {
            if (!open) {
              setConnectApp(null);
              setConnectAgentName(undefined);
            }
          }}
          onConnect={() => {
            const provider = connectApp.id;
            const agent = connectAgentName;
            setConnectApp(null);
            setConnectAgentName(undefined);
            openConnectPopup(provider, { agentName: agent });
          }}
        />
      )}

      {premiumApp && (
        <ProAppDialog
          appName={premiumApp.name}
          appIcon={premiumApp.icon}
          appDarkIcon={premiumApp.darkIcon}
          description={premiumApp.description}
          open={!!premiumApp}
          onOpenChange={(open) => {
            if (!open) setProApp(null);
          }}
        />
      )}

      {configApp?.configurable && (
        <ConfigureCredentialsDialog
          provider={configApp.id}
          appName={configApp.name}
          appIcon={configApp.icon}
          appDarkIcon={configApp.darkIcon}
          fields={configApp.configurable.fields}
          hint={configApp.configurable.hint}
          open={!!configApp}
          onOpenChange={(open) => {
            if (!open) setConfigApp(null);
          }}
          pageScope={pageScope}
          onConfigured={() => {
            const provider = configApp.id;
            setConfigApp(null);
            openConnectPopup(provider);
          }}
        />
      )}
    </>
  );
};

interface AppRowProps {
  name: string;
  icon: string;
  darkIcon?: string;
  connectionCount: number;
  cloudOnly?: boolean;
  hideDetails?: boolean;
  /** Credential data needed to route this app's connect action hasn't arrived. */
  connectPending?: boolean;
  onConnect: (e: React.MouseEvent) => void;
  /** Omitted while the row's action is held pending — the row renders inert. */
  onClick?: () => void;
}

const AppRow = ({
  name,
  icon,
  darkIcon,
  connectionCount,
  cloudOnly,
  hideDetails,
  connectPending,
  onConnect,
  onClick,
}: AppRowProps) => {
  const connected = connectionCount > 0;
  return (
    <div
      className={cn(
        "group flex items-center gap-3 rounded-xl border bg-card px-4 py-3.5 transition-colors",
        onClick &&
          "cursor-pointer hover:bg-accent/50 has-[button:hover]:bg-card!",
        connected && "border-brand/30",
      )}
      onClick={onClick}
    >
      <div className="flex flex-1 items-center gap-3 min-w-0">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
          <AppIcon icon={icon} darkIcon={darkIcon} name={name} />
        </div>
        <div className="min-w-0">
          <span className="text-sm font-medium">{name}</span>
          {!cloudOnly && !hideDetails && (
            <p className="text-[11px] text-muted-foreground group-hover:underline group-hover:text-foreground group-has-[button:hover]:no-underline group-has-[button:hover]:text-muted-foreground transition-colors">
              View details
            </p>
          )}
        </div>
      </div>

      {cloudOnly ? (
        <UnavailableBadge />
      ) : (
        <div className="flex items-center gap-2 shrink-0">
          {!hideDetails && (
            <ChevronRight className="size-4 text-muted-foreground transition-all group-hover:text-foreground group-hover:translate-x-0.5 group-has-[button:hover]:text-muted-foreground group-has-[button:hover]:translate-x-0" />
          )}
          <div className="border-l pl-2 min-w-20 flex justify-center">
            {connected ? (
              <div className="flex flex-col items-center">
                <span className="text-xs font-medium text-brand">
                  Connected
                </span>
                {connectionCount > 1 && (
                  <span className="text-[11px] text-muted-foreground">
                    {connectionCount} accounts
                  </span>
                )}
              </div>
            ) : (
              // A disabled Button is `pointer-events:none`, so a click aimed at
              // it would otherwise fall through to the row and navigate away.
              <div
                onClick={
                  connectPending ? (e) => e.stopPropagation() : undefined
                }
              >
                <Button size="xs" loading={connectPending} onClick={onConnect}>
                  Connect
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
