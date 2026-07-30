import { apiGet, apiPatch, apiDelete } from "./client";
import type { Project } from "./types";

// The project's own row. Nothing else in the API exposes a project's name
// (`GET /v1/auth/session` returns only `projectId`), so the settings page reads
// it here.
export const get = (id: string) => apiGet<Project>(`/v1/projects/${id}`);

export const rename = (id: string, name: string) =>
  apiPatch<Project>(`/v1/projects/${id}`, { name });

export const remove = (id: string) => apiDelete(`/v1/projects/${id}`);
