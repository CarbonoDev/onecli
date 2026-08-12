import { apiGet, apiPost, apiDelete } from "./client";
import type { OrgDomainRow } from "./types";

// The org's claimed email domains — organization-scoped only, admin-only
// server-side.
const base = "/v1/org/domains";

/**
 * No cursor envelope, unlike the group/member directories: an organization
 * holds a handful of domains, and every consumer wants all of them.
 */
export const list = () => apiGet<OrgDomainRow[]>(base);

/**
 * The raw string as typed. Normalization (lowercase, trailing dot, punycode)
 * is the SERVER's job — it owns the value the global unique index sees, so
 * doing it here as well would only create a second, drifting definition.
 */
export const claim = (domain: string) =>
  apiPost<OrgDomainRow>(base, { domain });

/**
 * Run the DNS check. A miss is a 4xx with the reason in the message and the row
 * left exactly as it was, so callers surface `error.message` rather than
 * reading a status off the returned row.
 */
export const verify = (domainId: string) =>
  apiPost<OrgDomainRow>(`${base}/${domainId}/verify`, {});

/**
 * The response body (`{ id, domain, verified }`) is deliberately dropped:
 * `apiDelete` resolves void, and the list refetch is what the UI reacts to.
 */
export const remove = (domainId: string) => apiDelete(`${base}/${domainId}`);
