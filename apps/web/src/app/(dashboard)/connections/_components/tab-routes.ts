/**
 * Where the connections tab bar points, and which tab the current URL is on.
 *
 * Extracted from `connections-tabs.tsx` so it can be unit tested without a DOM.
 * There are now TWO sections ending in `connections` — the project page at
 * `/connections` and the org page at `/global-connections` — and the fallback
 * path parsing used to be a substring scan for the literal `"/connections"`.
 * That scan does NOT match `/global-connections` (the `connections` there is
 * preceded by `-`, not `/`), so it fell through to its `/connections` default:
 * every org tab pointed at the PROJECT page, and every org URL read as the
 * `apps` tab. No error, no warning — the tabs simply went somewhere else.
 *
 * Matching whole SEGMENTS is what makes the two sections distinguishable.
 * `basePath` still wins when a caller passes it; the fallback is now correct on
 * its own rather than relying on every caller remembering to.
 */

export const CONNECTIONS_TABS = [
  "apps",
  "custom",
  "llms",
  "budgets",
  "vaults",
  "connected",
] as const;

export type ConnectionsTab = (typeof CONNECTIONS_TABS)[number];

/** Path segments that name a connections section root. */
const SECTION_SEGMENTS = new Set(["connections", "global-connections"]);

export const isConnectionsTab = (value: string): value is ConnectionsTab =>
  (CONNECTIONS_TABS as readonly string[]).includes(value);

/**
 * Split a pathname at its connections section root: everything up to and
 * including the section segment, and everything under it.
 *
 * Segment-wise, never a substring scan — see the module comment. Handles the
 * project prefix (`/p/<id>/connections/custom`) for free, since the prefix is
 * simply the segments before the match.
 */
const splitAtSection = (pathname: string): { base: string; rest: string } => {
  const segments = pathname.split("/");
  const idx = segments.findIndex((segment) => SECTION_SEGMENTS.has(segment));
  if (idx < 0) return { base: "/connections", rest: "" };
  return {
    base: segments.slice(0, idx + 1).join("/"),
    rest: segments.slice(idx + 1).join("/"),
  };
};

/**
 * The href for every tab. `basePath` is the authority when given (the org page
 * passes `/global-connections` literally); otherwise the section root is read
 * off `pathname`.
 */
export const tabRoutesFor = (
  pathname: string,
  basePath?: string,
): Record<ConnectionsTab, string> => {
  const base = basePath ?? splitAtSection(pathname).base;
  return {
    apps: base,
    custom: `${base}/custom`,
    llms: `${base}/llms`,
    budgets: `${base}/budgets`,
    vaults: `${base}/vaults`,
    connected: `${base}/connected`,
  };
};

/**
 * Which tab `pathname` is on. Anything that is not a bare tab segment — the
 * section root, an app detail page, a vault detail page — reads as `apps`,
 * which is the section root's own tab.
 */
export const activeTabFor = (
  pathname: string,
  basePath?: string,
): ConnectionsTab => {
  const rest =
    basePath && (pathname === basePath || pathname.startsWith(`${basePath}/`))
      ? pathname.slice(basePath.length).replace(/^\//, "")
      : splitAtSection(pathname).rest;
  return isConnectionsTab(rest) ? rest : "apps";
};
