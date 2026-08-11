import { apiGet, apiPost, apiPatch, apiDelete } from "./client";
import type { Project } from "./types";

// Every project the caller may use, oldest first — the switcher's source. The
// org comes from the request scope the proxy sets (the `/org/<id>` path, or the
// session's own org on flat editions), so there is no parameter here. Upstream
// widens `apiGet` with an `X-Organization-Id` override in v1.45.0 for its
// account-route picker; add it here when that lands.
export const list = () => apiGet<Project[]>("/v1/projects");

export const create = (name: string) =>
  apiPost<Project>("/v1/projects", { name });

// The project's own row. Nothing else in the API exposes a project's name
// (`GET /v1/auth/session` returns only `projectId`), so the settings page reads
// it here.
export const get = (id: string) => apiGet<Project>(`/v1/projects/${id}`);

export const rename = (id: string, name: string) =>
  apiPatch<Project>(`/v1/projects/${id}`, { name });

export const remove = (id: string) => apiDelete(`/v1/projects/${id}`);
