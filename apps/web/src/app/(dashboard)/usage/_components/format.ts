// Locales are PINNED, never left to the ambient default: these strings are
// produced during server rendering and again on the client, and an unpinned
// `Intl`/`toLocaleDateString` resolves to whatever locale each side happens to
// have — a hydration mismatch that shows up as "99,244" vs "99 244". The rest
// of the codebase pins the same way (see `members-table.tsx`).

const COUNT_FORMAT = new Intl.NumberFormat("en-US");

/** `99244` → `99,244`. */
export const formatCount = (value: number) => COUNT_FORMAT.format(value);

const formatDay = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

/** `Jul 12, 2026 – Aug 11, 2026` — the window the numbers actually cover. */
export const formatPeriod = (startIso: string, endIso: string) =>
  `${formatDay(startIso)} – ${formatDay(endIso)}`;

/**
 * A row's share of the total, as a percentage for the proportional bar.
 *
 * The zero-total divide is the whole reason this is a function: a fresh
 * instance has no recorded requests at all, so `total` is 0 on the only path
 * most people will ever see, and `0/0` would render `NaN%` into the bar.
 */
export const shareOfTotal = (value: number, total: number) =>
  total > 0 ? (value / total) * 100 : 0;
