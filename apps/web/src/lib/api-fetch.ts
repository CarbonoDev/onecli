import { DEFAULT_ORG_COOKIE, DEFAULT_PROJECT_COOKIE } from "@/lib/navigation";

export const API_ORIGIN = "";

export const getAuthToken = async (): Promise<string | undefined> => undefined;

/**
 * Read a scope cookie, client-side only.
 *
 * Guarded on `document` because `getProjectId` is called from `queryKeys`'
 * `scope()` during render, which also runs on the server. Returning undefined
 * there is correct: server components take their scope from the request headers
 * the proxy already set, never from this.
 */
const readScopeCookie = (name: string): string | undefined => {
  if (typeof document === "undefined") return undefined;
  return document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${name}=`))
    ?.split("=")[1];
};

/**
 * The project the switcher selected.
 *
 * No longer a stub, and the reason matters. `proxy.ts` turns the same cookie
 * into `X-Project-Id`, but its matcher deliberately EXCLUDES `v1`, so the
 * middleware never runs on API calls. Page requests therefore carried the
 * selected project while every client-side call to `/v1/*` did not — and the
 * API's `resolveProjectId`, seeing no header, silently fell back to the
 * caller's DEFAULT project. That is why creating an agent after switching
 * wrote it to the wrong project.
 */
export const getProjectId = (): string | undefined =>
  readScopeCookie(DEFAULT_PROJECT_COOKIE);

export const getOrganizationId = (): string | undefined =>
  readScopeCookie(DEFAULT_ORG_COOKIE);

export const apiFetch = (
  path: string,
  options?: RequestInit,
): Promise<Response> => {
  const headers = new Headers(options?.headers);

  // An explicit header from the caller always wins: `projects.list()` sets
  // X-Organization-Id for the account-route picker, and that must not be
  // overwritten by the ambient selection.
  const projectId = getProjectId();
  if (projectId && !headers.has("x-project-id")) {
    headers.set("x-project-id", projectId);
  }
  const organizationId = getOrganizationId();
  if (organizationId && !headers.has("x-organization-id")) {
    headers.set("x-organization-id", organizationId);
  }

  return fetch(path, { ...options, headers });
};
