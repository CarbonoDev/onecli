import { apiGet } from "./client";
import type { Organization } from "./types";

// The organizations the caller is an active member of — the org switcher's
// source. No parameters: the answer depends only on who is asking.
export const list = () => apiGet<Organization[]>("/v1/organizations");
