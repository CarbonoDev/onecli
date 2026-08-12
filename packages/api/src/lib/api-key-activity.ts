import { lastActivity, type LastActivity } from "./last-activity";

/**
 * The instant `api_keys.last_used_at` started recording — the timestamp of the
 * migration that added the column (20260812101500_add_api_key_last_used_at).
 *
 * Unlike the agents' last-seen this is not a rolling query bound; the column
 * records continuously. It is the honesty bound on calling a null "never": a
 * key minted at or after this instant with no `lastUsedAt` provably has never
 * authenticated, while an older key's null only means it has not authenticated
 * *since the column existed*. Hard-coded on purpose — it is a fact about the
 * schema's history, not a tunable.
 */
export const API_KEY_USAGE_TRACKED_SINCE = Date.parse("2026-08-12T10:15:00Z");

export type ApiKeyLastUsed = LastActivity;

/**
 * The card-facing reading of an API key's `lastUsedAt` — the answer to "is
 * this key still in circulation", which is the whole point of the column: a
 * key that leaked is otherwise indistinguishable from one that never left the
 * machine it was minted on.
 *
 * Recency is deliberately coarse. The write is throttled
 * (API_KEY_LAST_USED_THROTTLE_MS), so this lags real use by up to that window
 * — invisible at the granularity rendered ("3h ago"), and the reason
 * observing a key costs no per-request write.
 */
export const apiKeyLastUsed = (
  lastUsedAt: Date | string | null,
  createdAt: Date | string,
  now = Date.now(),
): ApiKeyLastUsed =>
  lastActivity({
    at: lastUsedAt,
    createdAt,
    verb: "Last used",
    observedSince: API_KEY_USAGE_TRACKED_SINCE,
    now,
  });
