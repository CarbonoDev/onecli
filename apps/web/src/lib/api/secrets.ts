import { apiGet, apiPost, apiPatch, apiDelete } from "./client";
import { secretsPath, type PageScope } from "./scope";
import type {
  CreateSecretInput as CreateSecretPayload,
  UpdateSecretInput,
} from "@onecli/api/validations/secret";
import type { Secret, CreatedSecret, CreateSecretInput } from "./types";

export const list = () => apiGet<Secret[]>("/v1/secrets");

// Scope-aware secrets list: org pages read /v1/org/secrets (admin-gated,
// requireProject: false), project pages /v1/secrets. Kept SEPARATE from `list`
// because a few callers pass `list` DIRECTLY as a React Query `queryFn` (which
// invokes it with its context object) — giving `list` a positional `scope` would
// make that context arrive as the scope. Both endpoints return the caller's OWN
// secrets (no inherited partner secrets), which is exactly what a policy target
// may reference.
export const listScoped = (scope: PageScope = "project") =>
  apiGet<Secret[]>(secretsPath(scope));

export const create = (input: CreateSecretInput) =>
  apiPost<CreatedSecret>("/v1/secrets", input);

/**
 * Scope-aware secret WRITES.
 *
 * Deliberately HTTP rather than a server action: `/v1/org/secrets` carries a
 * `role: "admin"` guard plus an org-credential check, and a server action would
 * have to re-implement that authorization — or, worse, become a way around it.
 * The project surface keeps its audited server actions
 * (`@/lib/actions/secrets`); these are the org triple.
 *
 * Typed against the validation schemas rather than `./types` so a
 * `SecretActions` implementation needs no assertion at the boundary.
 */
export const createScoped = (scope: PageScope, input: CreateSecretPayload) =>
  apiPost<CreatedSecret>(secretsPath(scope), input);

export const updateScoped = (
  scope: PageScope,
  secretId: string,
  input: UpdateSecretInput,
) => apiPatch<{ success: true }>(secretsPath(scope, `/${secretId}`), input);

export const removeScoped = (scope: PageScope, secretId: string) =>
  apiDelete(secretsPath(scope, `/${secretId}`));
