/**
 * OAuth 2.0 Dynamic Client Registration (RFC 7591).
 *
 * The MCP authorization pattern: the server advertises a `registration_endpoint`
 * and `token_endpoint_auth_methods_supported: ["none"]`, so a client registers
 * itself, gets a public `client_id`, and authenticates with PKCE alone. There is
 * no secret for an operator to configure, which is why these apps declare
 * `dynamicRegistration` instead of `configurable` (BYOC).
 *
 * The minted client id is cached in the project's AppConfig row. A client id is
 * only valid for the redirect URIs it was registered with, so the cache is keyed
 * by (region, redirectUri) and a change in either re-registers.
 */

import {
  getAppConfig,
  upsertDynamicClientConfig,
} from "../../services/app-config-service";
import { logger } from "../../lib/logger";
import type { AppDefinition } from "../types";
import type { ResolvedAppCredentials } from "../resolve-credentials";

/** RFC 7591 response fields this resolver reads. */
interface RegistrationResponse {
  client_id?: string;
  error?: string;
  error_description?: string;
}

/** Pick the region for a connect: the caller's choice when the app hosts it,
 *  the app's default (first entry) otherwise. */
export const resolveRegion = (
  registration: NonNullable<AppDefinition["dynamicRegistration"]>,
  requested?: string,
): string => {
  const fallback = registration.regions[0]!;
  if (!requested) return fallback;
  return registration.regions.includes(requested) ? requested : fallback;
};

const registerClient = async (
  appDef: AppDefinition,
  registration: NonNullable<AppDefinition["dynamicRegistration"]>,
  redirectUri: string,
  region: string,
  scopes: string[],
): Promise<string> => {
  const url = registration.registrationUrl(region);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: registration.clientName,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(scopes.length ? { scope: scopes.join(" ") } : {}),
    }),
  });

  const body = (await res
    .json()
    .catch(() => ({}) as RegistrationResponse)) as RegistrationResponse;

  if (!res.ok || !body.client_id) {
    throw new Error(
      `${appDef.name} client registration failed (${res.status}): ${
        body.error_description ?? body.error ?? res.statusText
      }`,
    );
  }

  return body.client_id;
};

export interface ResolveDynamicClientOptions {
  /** Register a new client when no reusable one is cached. False on the OAuth
   *  callback: the authorization code is bound to the client that started the
   *  flow, so minting a fresh one there could only produce a failed exchange. */
  allowRegister: boolean;
}

/**
 * Shaped like {@link ResolvedAppCredentials} so the connect routes treat both
 * credential paths alike, plus `registered`: true only when this call minted a
 * new client (the state-changing case the caller audits).
 */
export interface DynamicClientResolution extends ResolvedAppCredentials {
  registered: boolean;
}

/**
 * The client credentials for a dynamic-registration app. `values` carries the
 * `clientId` and the `region` the app definition needs to pick its regional
 * endpoints.
 */
export const resolveDynamicClient = async (
  scope: { projectId: string },
  appDef: AppDefinition,
  redirectUri: string,
  region: string,
  scopes: string[],
  { allowRegister }: ResolveDynamicClientOptions,
): Promise<DynamicClientResolution | null> => {
  const registration = appDef.dynamicRegistration;
  if (!registration) return null;

  const cached = await getAppConfig(scope, appDef.id);
  if (
    cached?.enabled &&
    cached.settings.clientId &&
    cached.settings.redirectUri === redirectUri &&
    cached.settings.region === region
  ) {
    return {
      values: { clientId: cached.settings.clientId, region },
      source: "app_config",
      registered: false,
    };
  }

  if (!allowRegister) return null;

  const clientId = await registerClient(
    appDef,
    registration,
    redirectUri,
    region,
    scopes,
  );

  await upsertDynamicClientConfig(scope, appDef.id, {
    clientId,
    redirectUri,
    region,
  });

  logger.info(
    { provider: appDef.id, region, ...scope },
    "registered dynamic OAuth client",
  );

  return {
    values: { clientId, region },
    source: "app_config",
    registered: true,
  };
};
