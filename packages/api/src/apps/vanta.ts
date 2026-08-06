import type { AppDefinition, OAuthExchangeResult } from "./types";

/**
 * Vanta's MCP server (https://developer.vanta.com/docs/vanta-mcp).
 *
 * Authorization follows the MCP pattern rather than Vanta's REST API pattern:
 * its protected-resource metadata advertises only `authorization_code` +
 * `refresh_token` with `token_endpoint_auth_methods_supported: ["none"]`, so
 * there is no client-credentials shortcut and no client secret — a public client
 * registered on demand (RFC 7591) authenticating with PKCE. The MCP scopes
 * (`mcp-api.*`) are also a different namespace from the REST API's
 * (`vanta-api.*`), so this connection grants the MCP server and nothing else.
 *
 * Connecting requires a Vanta Admin — non-admins cannot authorize MCP access.
 */

/** Vanta hosts each region separately; `us` is the default deployment. */
const REGIONS = ["us", "eu", "aus"] as const;

/** Regional hosts are `<service>.<region>.vanta.com`, with US unprefixed. */
const regionSuffix = (region: string): string =>
  region === "us" ? "" : `.${region}`;

const authorizeUrlFor = (region: string): string =>
  `https://app${regionSuffix(region)}.vanta.com/oauth/authorize`;

const tokenUrlFor = (region: string): string =>
  `https://api${regionSuffix(region)}.vanta.com/oauth/token`;

const registrationUrlFor = (region: string): string =>
  `https://api${regionSuffix(region)}.vanta.com/oauth/register`;

/** The host the gateway injects into — also the OAuth resource indicator. */
export const vantaMcpHost = (region: string): string =>
  `mcp${regionSuffix(region)}.vanta.com`;

const SCOPES = ["mcp-api.all:read", "mcp-api.all:write"];

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

const exchangeCode = async ({
  appCredentials,
  callbackParams,
  redirectUri,
  codeVerifier,
}: {
  appCredentials: Record<string, string>;
  callbackParams: Record<string, string>;
  redirectUri: string;
  codeVerifier?: string;
}): Promise<OAuthExchangeResult> => {
  if (callbackParams.error) {
    throw new Error(
      `Vanta authorization error: ${callbackParams.error} — ${
        callbackParams.error_description ?? "no description"
      }`,
    );
  }
  if (!callbackParams.code) {
    throw new Error("Vanta callback missing authorization code");
  }
  if (!appCredentials.clientId) {
    throw new Error("Vanta OAuth client not registered");
  }
  if (!codeVerifier) {
    throw new Error("Vanta token exchange requires a PKCE verifier");
  }

  const region = appCredentials.region || REGIONS[0];
  const tokenUrl = tokenUrlFor(region);
  const mcpHost = vantaMcpHost(region);

  const tokenRes = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: callbackParams.code,
      redirect_uri: redirectUri,
      client_id: appCredentials.clientId,
      code_verifier: codeVerifier,
      // RFC 8707 resource indicator — the MCP spec requires clients to name the
      // resource server the token is for.
      resource: `https://${mcpHost}`,
    }),
  });

  const tokenData = (await tokenRes
    .json()
    .catch(() => ({}) as TokenResponse)) as TokenResponse;

  if (!tokenRes.ok || tokenData.error || !tokenData.access_token) {
    throw new Error(
      tokenData.error_description ??
        tokenData.error ??
        `Vanta token exchange failed (${tokenRes.status})`,
    );
  }

  return {
    credentials: {
      access_token: tokenData.access_token,
      token_type: tokenData.token_type ?? "Bearer",
      expires_at:
        Math.floor(Date.now() / 1000) + (tokenData.expires_in ?? 3600),
      // The gateway refreshes autonomously: it needs the refresh token, the
      // public client id it was issued to (there is no secret and no env
      // fallback), and the region's token endpoint.
      ...(tokenData.refresh_token
        ? { refresh_token: tokenData.refresh_token }
        : {}),
      client_id: appCredentials.clientId,
      token_url: tokenUrl,
      // Gated injection: the token is only ever injected into the region it was
      // minted for, never a sibling region's MCP host.
      mcp_host: mcpHost,
      region,
    },
    scopes: tokenData.scope?.split(/\s+/).filter(Boolean) ?? SCOPES,
    metadata: {
      region,
      mcpHost,
      // Vanta's MCP scopes carry no identity endpoint, so the region stands in
      // as the connection label; users can rename it.
      name: `Vanta (${region.toUpperCase()})`,
    },
  };
};

export const vanta: AppDefinition = {
  id: "vanta",
  name: "Vanta",
  icon: "/icons/vanta.png",
  description:
    "Compliance automation — remediate failing tests, manage controls, and review vendor risk through Vanta's MCP server.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: SCOPES,
    pkce: true,
    permissions: [
      {
        scope: "mcp-api.all:read",
        name: "Compliance data",
        description:
          "Tests, controls, policies, vendors, personnel, and framework status",
        access: "read",
      },
      {
        scope: "mcp-api.all:write",
        name: "Compliance data",
        description:
          "Remediate tests, update controls, and act on compliance findings",
        access: "write",
      },
    ],
    buildAuthUrl: ({
      appCredentials,
      redirectUri,
      scopes,
      state,
      codeChallenge,
    }) => {
      if (!appCredentials.clientId) {
        throw new Error("Vanta OAuth client not registered");
      }
      if (!codeChallenge) {
        throw new Error("Vanta authorization requires a PKCE challenge");
      }

      const region = appCredentials.region || REGIONS[0];
      const url = new URL(authorizeUrlFor(region));
      url.searchParams.set("client_id", appCredentials.clientId);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set(
        "scope",
        (scopes.length ? scopes : SCOPES).join(" "),
      );
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("resource", `https://${vantaMcpHost(region)}`);
      return url.toString();
    },
    exchangeCode,
  },
  labelHint: 'e.g. "vanta-prod"',
  available: true,
  dynamicRegistration: {
    clientName: "OneCLI",
    regions: REGIONS,
    registrationUrl: registrationUrlFor,
  },
};
