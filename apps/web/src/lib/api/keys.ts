import { getProjectId, getOrganizationId } from "@/lib/api-fetch";
import type { PageScope } from "./scope";

const scope = () =>
  [getOrganizationId() ?? "default", getProjectId() ?? "default"] as const;

export const queryKeys = {
  /**
   * The selection cookies, held in the query cache so a switch re-renders every
   * subscriber instead of stranding them on a mount-effect read.
   *
   * Deliberately NOT `scope()`-prefixed, and this is the one group that must
   * not be: these keys ARE the scope source, so prefixing them with the scope
   * they produce would be circular — the key would change identity the moment
   * its own value did.
   */
  scope: {
    organizationCookie: () => ["scope", "org-cookie"] as const,
    projectCookie: () => ["scope", "project-cookie"] as const,
    /**
     * `GET /v1/auth/session` — the scope the SERVER resolved, the fallback both
     * `useCurrentProjectId` and `useCurrentOrganizationId` fall back to when no
     * cookie has been written. One key so the two hooks share one request and
     * can never disagree about what the server answered. Un-prefixed for the
     * same reason as its siblings: it is a scope source, not a scoped read.
     */
    session: () => ["scope", "session"] as const,
  },
  agents: {
    all: () => ["agents", ...scope()] as const,
    list: () => [...queryKeys.agents.all(), "list"] as const,
    detail: (agentId: string) =>
      [...queryKeys.agents.all(), "detail", agentId] as const,
    // Explicitly-targeted project (the org-level picker) — keyed by that
    // project, deliberately outside the URL-derived scope() prefix.
    forProject: (projectId: string) =>
      ["agents", "for-project", projectId] as const,
  },
  secrets: {
    all: () => ["secrets", ...scope()] as const,
    /**
     * Scope-parameterized like `connections.list`, and for the same reason: the
     * org page reads `/v1/org/secrets` and the project page `/v1/secrets`, two
     * different row sets that must never share a cache entry. Callers needing a
     * further split append a trailing segment (`"connected"`,
     * `"policy-target"`) — still under `all()`, so ONE invalidation at
     * `secrets.all()` breadth covers every variant. Keep it that broad: an org
     * secret created here becomes an INHERITED row on every project's
     * Connections page, and narrowing to the org key would leave those stale.
     */
    list: (pageScope: PageScope = "project") =>
      [...queryKeys.secrets.all(), "list", pageScope] as const,
  },
  policy: {
    all: () => ["policy", ...scope()] as const,
    rules: (pageScope: PageScope = "project") =>
      [...queryKeys.policy.all(), "rules", pageScope] as const,
    default: (pageScope: PageScope = "project") =>
      [...queryKeys.policy.all(), "default", pageScope] as const,
    lastPublish: (pageScope: PageScope = "project") =>
      [...queryKeys.policy.all(), "last-publish", pageScope] as const,
  },
  groups: {
    all: () => ["groups", ...scope()] as const,
    list: () => [...queryKeys.groups.all(), "list"] as const,
    members: (groupId: string) =>
      [...queryKeys.groups.all(), groupId, "members"] as const,
  },
  roleMappings: {
    all: () => ["role-mappings", ...scope()] as const,
    list: () => [...queryKeys.roleMappings.all(), "list"] as const,
  },
  orgMembers: {
    all: () => ["org-members", ...scope()] as const,
    list: () => [...queryKeys.orgMembers.all(), "list"] as const,
  },
  invitations: {
    all: () => ["invitations", ...scope()] as const,
    list: () => [...queryKeys.invitations.all(), "list"] as const,
  },
  grants: {
    all: () => ["grants", ...scope()] as const,
    agent: (agentId: string) =>
      [...queryKeys.grants.all(), "agent", agentId] as const,
    connection: (connectionId: string) =>
      [...queryKeys.grants.all(), "connection", connectionId] as const,
  },
  connections: {
    all: () => ["connections", ...scope()] as const,
    list: (pageScope: PageScope = "project") =>
      [...queryKeys.connections.all(), "list", pageScope] as const,
    byProvider: (provider: string) =>
      [...queryKeys.connections.all(), "provider", provider] as const,
  },
  projects: {
    all: () => ["projects", ...scope()] as const,
    detail: (projectId: string) =>
      [...queryKeys.projects.all(), projectId] as const,
    // organizationId only when explicitly overridden (account-route picker).
    list: (organizationId?: string) =>
      [...queryKeys.projects.all(), "list", organizationId ?? "url"] as const,
  },
  organizations: {
    all: () => ["organizations"] as const,
    list: () => [...queryKeys.organizations.all(), "list"] as const,
  },
  projectAccess: {
    all: () => ["project-access", ...scope()] as const,
    list: (projectId: string) =>
      [...queryKeys.projectAccess.all(), projectId] as const,
  },
  appPermissionDefinitions: {
    // Global static catalog (identical across orgs/projects) — deliberately
    // not scope-keyed.
    all: () => ["app-permission-definitions"] as const,
    list: () => [...queryKeys.appPermissionDefinitions.all(), "list"] as const,
  },
  appConfig: {
    all: () => ["appConfig", ...scope()] as const,
    status: (provider: string, pageScope: PageScope) =>
      [...queryKeys.appConfig.all(), provider, pageScope] as const,
    configured: (pageScope: PageScope) =>
      [...queryKeys.appConfig.all(), "configured", pageScope] as const,
    envDefaults: () => [...queryKeys.appConfig.all(), "envDefaults"] as const,
  },
  appAvailability: {
    all: () => ["appAvailability", ...scope()] as const,
    available: () => [...queryKeys.appAvailability.all(), "available"] as const,
  },
  apiKey: {
    all: () => ["api-key", ...scope()] as const,
    /** The caller's personal key IN the current project — scope()-prefixed, so
     * a project or org switch re-keys it instead of showing the last one. */
    current: () => [...queryKeys.apiKey.all(), "current"] as const,
  },
  counts: {
    all: () => ["counts", ...scope()] as const,
  },
  installInfo: {
    all: () => ["install-info", ...scope()] as const,
  },
  userPlan: {
    all: () => ["user-plan", ...scope()] as const,
  },
  vaults: {
    all: () => ["vaults", ...scope()] as const,
    list: () => [...queryKeys.vaults.all(), "list"] as const,
  },
  activity: {
    all: () => ["activity", ...scope()] as const,
    list: (filter?: string) =>
      [...queryKeys.activity.all(), "list", filter] as const,
  },
  approvals: {
    all: () => ["approvals", ...scope()] as const,
    list: () => [...queryKeys.approvals.all(), "list"] as const,
  },
  appBlocklist: {
    all: () => ["appBlocklist", ...scope()] as const,
    byProvider: (provider: string) =>
      [...queryKeys.appBlocklist.all(), provider] as const,
  },
  budgets: {
    all: () => ["budgets", ...scope()] as const,
    list: () => [...queryKeys.budgets.all(), "list"] as const,
  },
  usage: {
    /**
     * `scope()`-prefixed even though `/v1/org/usage` takes no project: the
     * response IS org-specific (it aggregates the projects the caller may reach
     * in the SELECTED org), so an org switch must refetch rather than show the
     * previous org's numbers under the new org's name.
     */
    all: () => ["usage", ...scope()] as const,
    summary: () => [...queryKeys.usage.all(), "summary"] as const,
  },
  billing: {
    all: () => ["billing", ...scope()] as const,
    planUsage: () => [...queryKeys.billing.all(), "planUsage"] as const,
    subscriptionStatus: () =>
      [...queryKeys.billing.all(), "subscriptionStatus"] as const,
    prorationPreview: (plan: string, interval: string) =>
      [...queryKeys.billing.all(), "prorationPreview", plan, interval] as const,
  },
  dropbox: {
    all: () => ["dropbox", ...scope()] as const,
    folders: (connectionId: string, path: string) =>
      [...queryKeys.dropbox.all(), "folders", connectionId, path] as const,
  },
  onepassword: {
    all: () => ["onepassword", ...scope()] as const,
    status: () => [...queryKeys.onepassword.all(), "status"] as const,
    vaults: () => [...queryKeys.onepassword.all(), "vaults"] as const,
    items: (vaultId: string) =>
      [...queryKeys.onepassword.all(), "items", vaultId] as const,
    fields: (vaultId: string, itemId: string) =>
      [...queryKeys.onepassword.all(), "fields", vaultId, itemId] as const,
  },
};
