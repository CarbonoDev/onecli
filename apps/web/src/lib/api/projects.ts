import { apiGet, apiPost, apiPatch, apiDelete } from "./client";
import type { Project } from "./types";

// Every project the caller may use, oldest first — the switcher's source and
// the account-route Get Started picker's.
//
// The org is normally derived from the /org/<id> path. The explicit override
// exists for the picker, whose org comes from the default-org cookie instead of
// the URL; the server validates membership either way.
export const list = (options: { organizationId?: string } = {}) =>
  apiGet<Project[]>(
    "/v1/projects",
    options.organizationId
      ? { headers: { "X-Organization-Id": options.organizationId } }
      : undefined,
  );

export const create = (name: string) =>
  apiPost<Project>("/v1/projects", { name });

// The project's own row. Nothing else in the API exposes a project's name
// (`GET /v1/auth/session` returns only `projectId`), so the settings page reads
// it here.
export const get = (id: string) => apiGet<Project>(`/v1/projects/${id}`);

export const rename = (id: string, name: string) =>
  apiPatch<Project>(`/v1/projects/${id}`, { name });

export const remove = (id: string) => apiDelete(`/v1/projects/${id}`);
