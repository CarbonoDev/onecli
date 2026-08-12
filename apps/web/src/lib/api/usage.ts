import { apiGet } from "./client";

// Org-scope usage: always `/v1/org/usage` (requireProject: false). Unlike the
// other `/v1/org/*` reads this one is member-visible — the API scopes the
// aggregate to the projects the caller may reach, so a member sees their own
// projects' traffic rather than a 403.

export interface UsageAgentRow {
  agentId: string;
  /** Null when the agent has since been deleted; render as "Deleted agent". */
  agentName: string | null;
  requests: number;
  integrationCalls: number;
}

export interface UsageSummary {
  /** ISO bounds of the measured window — label the numbers with THESE. */
  periodStart: string;
  periodEnd: string;
  /**
   * Requests the gateway RECORDED, which is not the same as requests it served:
   * it writes a row only when it injected a credential or made a non-plain-allow
   * policy decision (`apps/gateway/src/telemetry.rs`). Pass-through traffic on an
   * agent's own key is invisible here, so this must never be labelled "total
   * gateway requests".
   */
  requests: number;
  /** Requests with credential injection — exact, since injection guarantees a row. */
  integrationCalls: number;
  agents: UsageAgentRow[];
}

export const get = () => apiGet<UsageSummary>("/v1/org/usage");
