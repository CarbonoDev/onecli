import { lastActivity, type LastActivity } from "./last-activity";

/**
 * Lookback for an agent's `lastSeenAt` on the agents list: the newest
 * request_logs row inside this window. Bounded so the per-project group-by
 * rides the (project_id, created_at) index instead of walking a busy
 * project's whole log history — and mirrored by `agentLastSeen` below, which
 * needs the same number to tell "never used" from "quiet longer than the
 * window". Client-safe (no db/next imports) for exactly that reason.
 */
export const LAST_SEEN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type AgentLastSeen = LastActivity;

/**
 * The card-facing reading of `lastSeenAt`. Agents have no presence — no
 * heartbeat, no connection — so "seen" can only ever mean "made a gateway
 * request". Null is ambiguous by construction (the window bounds the query):
 * an agent *created inside* the window provably never made a request, while
 * an older agent may just have been quiet longer than the window — the two
 * get honest, distinct labels.
 */
export const agentLastSeen = (
  lastSeenAt: Date | string | null,
  createdAt: Date | string,
  now = Date.now(),
): AgentLastSeen =>
  lastActivity({
    at: lastSeenAt,
    createdAt,
    verb: "Last seen",
    // Rolling: the group-by only looked back this far, so that is exactly how
    // far "no row" is evidence of anything.
    observedSince: now - LAST_SEEN_WINDOW_MS,
    now,
  });
