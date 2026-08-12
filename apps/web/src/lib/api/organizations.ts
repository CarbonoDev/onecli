import { apiGet, apiPatch, apiPost } from "./client";
import type { CreatedOrganization, Organization } from "./types";

// The organizations the caller is an active member of — the org switcher's
// source. No parameters: the answer depends only on who is asking.
export const list = () => apiGet<Organization[]>("/v1/organizations");

/**
 * Create an organization, with the caller as its owner. Name only — the slug
 * is derived server-side.
 *
 * The response carries `projectId`, the default project the new org is born
 * with: the caller switches to BOTH at once, so the new org never renders
 * without a project scope.
 */
export const create = (name: string) =>
  apiPost<CreatedOrganization>("/v1/organizations", { name });

/**
 * Rename an organization. Admin-only server-side; the response omits `role`
 * (the caller's membership is unchanged by a rename) and carries `slug`
 * unchanged — it is immutable.
 */
export const rename = (id: string, name: string) =>
  apiPatch<Pick<Organization, "id" | "name" | "slug">>(
    `/v1/organizations/${id}`,
    { name },
  );
