import { formatRelative } from "./format";

/**
 * Activity newer than this renders the card's freshness dot — "in use right
 * now" rather than "was used at some point". Shared by every subject so the
 * dot means the same thing wherever it appears.
 */
const FRESH_WINDOW_MS = 60 * 60 * 1000;

export interface LastActivity {
  label: string;
  /** Exact timestamp for a hover title; null when there is nothing to show. */
  exactAt: Date | null;
  /** Active within the last hour — the card renders its activity dot. */
  fresh: boolean;
}

export interface LastActivityInput {
  /** Newest observed activity, or null when none is known. */
  at: Date | string | null;
  /** When the subject was created — the only thing that disambiguates a null `at`. */
  createdAt: Date | string;
  /** Verb for the populated arm, e.g. "Last seen" / "Last used". */
  verb: string;
  /**
   * Epoch ms from which activity has actually been observable — a rolling
   * query bound for one subject, a fixed instant for another. A null `at` on
   * a subject created BEFORE this is ambiguous (it may simply predate the
   * observation) and must not be reported as "never".
   */
  observedSince: number;
  now?: number;
}

/**
 * The card-facing reading of a "last activity" timestamp.
 *
 * The one rule worth preserving across subjects: a null timestamp is
 * ambiguous by construction, and the two readings get honest, distinct labels
 * instead of a single blank. A subject created once observation had already
 * begun provably has no activity; an older one may simply have been active
 * before anything was watching.
 */
export const lastActivity = ({
  at,
  createdAt,
  verb,
  observedSince,
  now = Date.now(),
}: LastActivityInput): LastActivity => {
  if (at !== null) {
    const seen = new Date(at);
    const relative = formatRelative(seen.toISOString(), now);
    return {
      // formatRelative capitalizes its "Just now" arm for standalone use;
      // mid-sentence it reads broken.
      label: `${verb} ${relative === "Just now" ? "just now" : relative}`,
      exactAt: seen,
      fresh: now - seen.getTime() < FRESH_WINDOW_MS,
    };
  }
  const neverUsed = new Date(createdAt).getTime() >= observedSince;
  return {
    label: neverUsed ? "Never used" : "No recent activity",
    exactAt: null,
    fresh: false,
  };
};
