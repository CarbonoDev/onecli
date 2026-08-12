import { secrets as secretsApi, type PageScope } from "@/lib/api";
import type { SecretActions } from "./types";

/**
 * The ORGANIZATION secret write triple, over HTTP.
 *
 * Not server actions: `@/lib/actions/secrets` resolves its scope through
 * `resolveProjectContext`, so it can only ever write project rows, and an org
 * variant would have to re-implement the `/v1/org/secrets` `role: "admin"`
 * guard — or become a way around it. Going through the API keeps that check in
 * exactly one place, and the 403 it returns is what the surfaces render.
 */
const organizationSecretActions: SecretActions = {
  createSecret: (input) => secretsApi.createScoped("organization", input),
  updateSecret: (secretId, input) =>
    secretsApi
      .updateScoped("organization", secretId, input)
      .then(() => undefined),
  deleteSecret: (secretId) => secretsApi.removeScoped("organization", secretId),
};

/**
 * The write triple for a page scope, or `undefined` at project scope — where
 * `SecretCard`/`SecretDialog`'s own audited server-action defaults already
 * apply and must not be replaced.
 */
export const defaultSecretActionsFor = (
  pageScope: PageScope,
): SecretActions | undefined =>
  pageScope === "organization" ? organizationSecretActions : undefined;
