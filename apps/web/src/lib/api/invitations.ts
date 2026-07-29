import { apiDelete, apiGet, apiPost } from "./client";
import type {
  CreateInvitationInput,
  DirectoryPage,
  DirectoryListParams,
  InvitationRow,
} from "./types";

// Link-based org invitations: the admin surface (list / create / revoke).
// There is no accept call here — accepting runs through a Server Action
// (`@/lib/actions/org-invitations`), never an HTTP route. The join link is
// composed client-side from `window.location.origin` + the row's token.
const base = "/v1/org/invitations";

export const list = (
  params: DirectoryListParams & { status?: InvitationRow["status"] } = {},
) => {
  const search = new URLSearchParams();
  if (params.limit) search.set("limit", String(params.limit));
  if (params.cursor) search.set("cursor", params.cursor);
  if (params.q) search.set("q", params.q);
  if (params.status) search.set("status", params.status);
  const qs = search.toString();
  return apiGet<DirectoryPage<InvitationRow>>(`${base}${qs ? `?${qs}` : ""}`);
};

export const create = (input: CreateInvitationInput) =>
  apiPost<InvitationRow>(base, input);

export const revoke = (invitationId: string) =>
  apiDelete(`${base}/${invitationId}`);
