/**
 * Matches `/p/<projectId>` at the start of a pathname and captures the id.
 * Shared across sidebar, header, and navigation helpers so the pattern stays
 * consistent.
 */
export const PROJECT_PATH_RE = /^\/p\/([^/]+)(?=\/|$)/;

/**
 * Prefix an absolute dashboard path with `/p/<projectId>` if the current
 * pathname is already inside a project scope. Used by shared dashboard
 * components (connections tabs, overview cards, app detail) so a "Secrets"
 * tab click inside `/p/<id>/connections` keeps the project prefix instead of
 * jumping to the OSS top-level `/connections/secrets`.
 *
 * In OSS the regex never matches (no `/p/<id>/` URLs exist) so the input
 * path is returned unchanged — this is a no-op for self-hosted users.
 */
export const ORG_PATH_RE = /^\/org\/([^/]+)(?=\/|$)/;

/**
 * The project a switcher last selected.
 *
 * Flat editions (`oss`, `onprem-slim`) strip the `/p/<id>` prefix in
 * `proxy.ts`, so on those builds the URL carries no project scope and there is
 * nothing for a switcher to ride on. This cookie is that transport: the proxy
 * turns it into the `X-Project-Id` header the API already understands.
 *
 * It is a HINT, never authority — `resolveProjectId` still validates the id
 * against the caller's memberships and `canAccessProjectAsUser` before trusting
 * it, so a forged or stale cookie resolves to nothing rather than to access.
 *
 * One definition so writer and reader can't drift. `readDefaultProjectCookie`
 * is client-side (`document.cookie`); the proxy reads the same name off the
 * request. Upstream v1.45.0 introduces the sibling `onecli-default-org` for
 * org scope in this file — keep the two together when that lands.
 */
export const DEFAULT_PROJECT_COOKIE = "onecli-default-project";

export const readDefaultProjectCookie = (): string | undefined =>
  document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${DEFAULT_PROJECT_COOKIE}=`))
    ?.split("=")[1];

/** Persist the selected project. `SameSite=Lax` so it survives ordinary
 * navigation but is not sent on cross-site requests; no `Secure` flag because
 * self-hosted installs are routinely plain HTTP on a private network. */
export const writeDefaultProjectCookie = (projectId: string): void => {
  const oneYear = 60 * 60 * 24 * 365;
  document.cookie = `${DEFAULT_PROJECT_COOKIE}=${encodeURIComponent(
    projectId,
  )}; path=/; max-age=${oneYear}; SameSite=Lax`;
};

export const withProjectPrefix = (
  currentPathname: string,
  targetPath: string,
): string => {
  const match = currentPathname.match(PROJECT_PATH_RE);
  if (!match) return targetPath;
  return `/p/${match[1]}${targetPath}`;
};

export const withOrgPrefix = (
  currentPathname: string,
  targetPath: string,
): string => {
  const match = currentPathname.match(ORG_PATH_RE);
  if (!match) return targetPath;
  return `/org/${match[1]}${targetPath}`;
};

/**
 * Resolve a path inside the connections section, scoped to the current edition
 * and page. Single source of truth so callers never hardcode the bare OSS
 * `/connections...` path (which 404s in the cloud edition under `/p` or `/org`).
 *
 * - OSS:           `/connections{sub}`
 * - Cloud project: `/p/<id>/connections{sub}`   (derived from `pathname`)
 * - Cloud org:     `<basePath>{sub}`            (basePath = `/org/<id>/global-connections`)
 *
 * `sub` is the path under the connections root, e.g. "" (root),
 * `/apps/<provider>`, or `/vaults/<provider>`.
 */
/** The agent detail page, scoped to the current edition (OSS `/agents/<id>`,
 * cloud `/p/<projectId>/agents/<id>` — the bare path 404s there). */
export const agentPath = (currentPathname: string, agentId: string): string =>
  withProjectPrefix(currentPathname, `/agents/${agentId}`);

export const connectionsPath = (
  { pathname, basePath }: { pathname: string; basePath?: string },
  sub = "",
): string =>
  basePath
    ? `${basePath}${sub}`
    : withProjectPrefix(pathname, `/connections${sub}`);
