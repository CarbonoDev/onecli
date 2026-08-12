export interface Agent {
  id: string;
  name: string;
  identifier: string;
  accessToken: string;
  isDefault: boolean;
  /** The all-vs-selective injection switch the gateway reads per request. Not
   * editable from the console since step 10 — policy rules decide access. */
  secretMode: string;
  createdAt: string;
  /** Newest gateway request inside the list's bounded lookback window; null =
   * none in-window (never used OR quiet — `agentLastSeen` tells them apart). */
  lastSeenAt: string | null;
}

export interface CreatedAgent {
  id: string;
  name: string;
  identifier: string;
  createdAt: string;
}

export interface AgentDetail {
  id: string;
  name: string;
  identifier: string;
  isDefault: boolean;
  createdAt: string;
  /** Newest gateway request inside the server's bounded lookback window — the
   * Install page's verify signal. Null when the agent has none in-window. */
  recentRequestAt: string | null;
}

export interface DropboxFolder {
  id: string;
  name: string;
  pathLower: string;
  pathDisplay: string;
}

export interface Secret {
  id: string;
  name: string;
  type: string;
  typeLabel: string;
  valueSource: string;
  opRef: string | null;
  hostPattern: string;
  pathPattern: string | null;
  injectionConfig: unknown;
  metadata: Record<string, unknown> | null;
  scope: string | null;
  createdAt: string;
}

export interface CreatedSecret {
  id: string;
  name: string;
  type: string;
  hostPattern: string;
  pathPattern: string | null;
  createdAt: string;
  preview: string;
}

export interface Connection {
  id: string;
  provider: string;
  label: string | null;
  status: string;
  scopes: string[];
  scope: string | null;
  metadata: unknown;
  connectedAt: string;
}

// A project row as returned by the project routes (list / get / create /
// rename — all four return this same shape).
//
// `resourceCount` is this project's OWN secrets + app connections; it
// deliberately excludes org-scoped resources shared by every project, so the
// numbers are comparable across cards. Agents are counted separately.
//
// `ownerEmail` is the creator's email as STORED on the project — provenance,
// not live identity, so it outlives a deleted account and does not follow an
// email change. Render `Owned by <ownerEmail>`; omit the line when null.
export interface Project {
  id: string;
  name: string | null;
  slug: string | null;
  createdAt: string;
  agentCount: number;
  resourceCount: number;
  ownerEmail: string | null;
}

// Project access bindings (the human sharing surface for a project). `role` is
// the management role on a user binding (step 13c): "owner" may manage the
// project, "member" is a plain use grant. `isOwner` flags the creator — a
// provenance display hint, distinct from the (transferable) management role.
export interface ProjectAccessUserRow {
  id: string;
  userId: string;
  name: string | null;
  email: string;
  role: "owner" | "member";
  isOwner: boolean;
  createdAt: string;
}

export interface ProjectAccessGroupRow {
  id: string;
  groupId: string;
  name: string;
  memberCount: number;
  createdAt: string;
}

export interface ProjectAccessBindings {
  users: ProjectAccessUserRow[];
  groups: ProjectAccessGroupRow[];
}

// The shares to keep. Each user carries a management `role` (owner = may manage
// the project); groups carry no role in v1.
export interface SetProjectAccessInput {
  users: { userId: string; role: "owner" | "member" }[];
  groupIds: string[];
}

// PATCH /v1/org/members/:userId — exactly one change per request. `owner` is
// not assignable here (owner transfer is a separate operation); the `ssoExempt`
// arm is gone with the SSO feature it belonged to.
export type UpdateOrgMemberInput =
  | { status: "active" | "suspended" }
  | { role: "admin" | "member" };

export interface OrgMemberRow {
  userId: string;
  status: string;
  ssoExempt: boolean;
  /** Present on status changes: what happened on the Cognito side. */
  revocation?: string;
}

/**
 * PATCH /v1/org/members/:userId response. The server echoes back only the
 * facet it changed, so the response mirrors the request's single-change shape.
 */
export type UpdatedOrgMember =
  | Pick<OrgMemberRow, "userId" | "status" | "ssoExempt">
  | { userId: string; role: string };

export interface ResourceCounts {
  agents: number;
  apps: number;
  llms: number;
  secrets: number;
}

export interface CreateAgentInput {
  name: string;
  identifier: string;
}

export interface CreateSecretInput {
  name: string;
  type: string;
  value?: string;
  valueSource?: "inline" | "onepassword";
  opRef?: string;
  opDisplay?: { vault: string; item: string; field: string };
  hostPattern: string;
  pathPattern?: string;
  injectionConfig?: unknown;
}

// ── Org directory (groups, members) ──

/** Cursor envelope shared by every directory-scale list. */
export interface DirectoryPage<T> {
  data: T[];
  nextCursor: string | null;
}

export interface DirectoryListParams {
  limit?: number;
  cursor?: string;
  q?: string;
}

export interface GroupRow {
  id: string;
  name: string;
  /** "scim" groups are IdP-managed — manual writes 409. */
  source: "manual" | "scim";
  externalId: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface GroupMemberRow {
  userId: string;
  email: string;
  name: string | null;
  addedAt: string;
}

// Group→role mappings (step 15): map an IdP group to an org role, priority-ordered.
export interface RoleMappingRow {
  id: string;
  groupId: string;
  groupName: string;
  role: "admin" | "member";
  priority: number;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRoleMappingInput {
  groupId: string;
  role: "admin" | "member";
  priority?: number;
}

export interface UpdateRoleMappingInput {
  role: "admin" | "member";
  priority?: number;
}

export interface RoleMappingImpact {
  affectedCount: number;
}

export interface OrgMemberListRow {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  status: string;
  ssoExempt: boolean;
  joinedAt: string;
}

// Link-based org invitations (`/v1/org/invitations`).
export interface InvitationRow {
  id: string;
  email: string;
  role: string;
  /** Projected: a stored "pending" past its expiresAt reads "expired". */
  status: "pending" | "accepted" | "cancelled" | "expired";
  invitedByEmail: string;
  expiresAt: string;
  createdAt: string;
  /** Raw link token — admin-only surface; the UI composes /join/<token>. */
  token: string;
}

export interface CreateInvitationInput {
  email: string;
  role: "admin" | "member";
}

// ── Shared policy identity/condition shapes ──────────────────────────────────
// Used by the editor's PolicyRuleV2. Project rules target a specific agent or
// "any" (empty); org rules target directory identities (user / user-group).
// Conditions are body OR header matches (contains/equals/regex/exists) — the
// wire shape mirrors the authoritative RuleCondition: `key` names the header
// (header target only) and `value` is absent for `exists`.

export type ProjectionIdentity =
  | { type: "agent"; id: string }
  | { type: "user"; id: string }
  | { type: "group"; id: string };

export interface ProjectionCondition {
  target: string;
  operator: string;
  value?: string;
  key?: string;
}

// ── Editable policy rules (policy_rules_v2) ──────────────────────────────────
// The editor's data (GET /rules → PolicyRuleDto): rows carry an `id` (for
// PATCH/DELETE), `enabled`, and are single-scope. Targets can be
// app/connection/secret/network — the dialog authors all four (an app target
// with no tools is the "All connections" whole-app shape; specific connections
// become `connection` targets).
export type PolicyRuleTarget =
  | {
      kind: "app";
      provider: string;
      // Named tools → the exact tool fan-out; EMPTY → the whole app (its
      // catalog hosts — permit on allow / block on block).
      tools: string[];
      // "All connections at a level" injection scope; null = no injection.
      // Injection-only — never affects matching.
      connectionScope: "organization" | "project" | null;
    }
  // Injects the connection and matches its provider's app — narrowed to `tools`
  // when set, else the whole app (empty = today's whole-app behavior).
  | { kind: "connection"; connectionId: string; tools: string[] }
  | {
      kind: "secret";
      // Step 8: a specific `secretId`, OR a `secretScope` ("all secrets at a
      // level") — exactly one is set.
      secretId: string | null;
      secretScope: "organization" | "project" | null;
    }
  | {
      kind: "network";
      hostPattern: string;
      pathPattern: string | null;
      method: string | null;
    };

export type PolicyRuleSource =
  | "custom"
  | "app_permission"
  | "blocklist"
  | "default"
  // Injection-only rules materialized from the equipment model (step 8); the
  // editor hides them (managed via the agent access UI).
  | "equipment"
  // Attach-model grant stacks (step 2): compiled by the grants API; rendered
  // as labeled, revocable derived rows until the project rules table retires.
  | "grant";

export interface PolicyRuleV2 {
  id: string;
  scope: "organization" | "project";
  status: "draft" | "published";
  generation: number;
  priority: number;
  enabled: boolean;
  isDefault: boolean;
  /** Generation-stable identity — the key for diffing draft vs published
   * (the row `id` regenerates on every publish). Empty on a virtual default. */
  logicalId: string;
  source: PolicyRuleSource;
  name: string;
  description: string | null;
  action: "allow" | "block";
  rateLimit: number | null;
  rateLimitWindow: "minute" | "hour" | "day" | null;
  requireApproval: boolean;
  conditions: ProjectionCondition[] | null;
  identities: ProjectionIdentity[];
  targets: PolicyRuleTarget[];
  createdAt: string;
}

export interface PublishResult {
  generation: number;
  ruleCount: number;
}

/** The scope's most recent publish. `appliedBy` null = a system publish (the
 * boot seeder); a null response = never published. */
export interface LastPublish {
  generation: number;
  ruleCount: number;
  appliedAt: string;
  appliedBy: { name: string | null; email: string } | null;
}

// ── Attach-model grants (plans/project-attach-model.md, step 2) ─────────────
// Hand-mirrored from packages/api/src/services/grants-service.ts and
// grants-summary-service.ts.

/** A grant's session policy ("Resources"): which repositories/folders the
 * connection's injected credential may reach. One strict axis per provider. */
export type GrantResources = { repositories: string[] } | { folders: string[] };

export interface AgentGrantConnection {
  connectionId: string;
  provider: string;
  label: string | null;
  scope: "project" | "organization";
  access: "full" | "custom";
  allow: string[];
  ask: string[];
  /** Null = unrestricted. */
  resources: GrantResources | null;
}

export interface AgentGrantSecret {
  secretId: string;
  name: string;
  type: string;
  scope: "project" | "organization";
}

export interface AgentGrants {
  agentId: string;
  /** "all" = the agent still injects the whole fenced pool (pre-flip). */
  mode: "all" | "grants";
  connections: AgentGrantConnection[];
  secrets: AgentGrantSecret[];
}

export interface ConnectionGrants {
  connectionId: string;
  agents: {
    agentId: string;
    access: "full" | "custom";
    allow: string[];
    ask: string[];
  }[];
}

/** `resources` is tri-state: ABSENT = preserve what the stack carries, NULL =
 * clear, OBJECT = set (server-validated per provider + edition). */
export type ConnectionGrantInput =
  | { access: "full"; resources?: GrantResources | null }
  | {
      access: "custom";
      allow: string[];
      ask: string[];
      resources?: GrantResources | null;
    };

export type GrantsSummaryEntry =
  | {
      kind: "app";
      provider: string;
      connectionId: string;
      label: string | null;
    }
  | { kind: "secret" | "llm"; id: string; name: string };

export interface AgentGrantsSummary {
  mode: "all" | "grants";
  entries: GrantsSummaryEntry[];
  total: number;
}

export interface AgentWithGrantsSummary extends Agent {
  grantsSummary: AgentGrantsSummary;
}

/** An org the caller belongs to, with their role in it (`GET /v1/organizations`). */
export interface Organization {
  id: string;
  name: string;
  slug: string;
  role: string;
}

/**
 * A just-created org (`POST /v1/organizations`), plus the default project it
 * was born with — what a switch to it needs.
 */
export interface CreatedOrganization extends Organization {
  projectId: string;
}

/**
 * `GET /v1/auth/session` — the caller's identity plus the scope the server
 * resolved for them. `projectId`/`organizationId` are OPTIONAL because "no
 * reachable project in the selected org" is a legitimate answer, not an error.
 */
export interface SessionInfo {
  id: string;
  email: string;
  name: string | null;
  projectId?: string;
  organizationId?: string;
}
