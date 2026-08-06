import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getAppConfig = vi.fn();
const upsertDynamicClientConfig = vi.fn();

vi.mock("../../services/app-config-service", () => ({
  getAppConfig,
  upsertDynamicClientConfig,
}));

const { resolveDynamicClient, resolveRegion } =
  await import("./dynamic-registration");

import type { AppDefinition } from "../types";

const appDef: AppDefinition = {
  id: "regional",
  name: "Regional App",
  icon: "/icons/regional.png",
  description: "Dynamic-registration test app",
  available: true,
  connectionMethod: {
    type: "oauth",
    pkce: true,
    buildAuthUrl: () => "https://provider.example/authorize",
    exchangeCode: async () => ({ credentials: {}, scopes: [] }),
  },
  dynamicRegistration: {
    clientName: "OneCLI",
    regions: ["us", "eu"],
    registrationUrl: (region) =>
      region === "us"
        ? "https://api.provider.example/oauth/register"
        : `https://api.${region}.provider.example/oauth/register`,
  },
};

const REDIRECT_URI = "https://api.example.com/v1/apps/regional/callback";
const SCOPES = ["mcp-api.all:read"];

const resolve = (
  allowRegister: boolean,
  region = "us",
  redirectUri = REDIRECT_URI,
) =>
  resolveDynamicClient(
    { projectId: "p1" },
    appDef,
    redirectUri,
    region,
    SCOPES,
    {
      allowRegister,
    },
  );

beforeEach(() => {
  getAppConfig.mockReset();
  upsertDynamicClientConfig.mockReset();
  upsertDynamicClientConfig.mockResolvedValue({
    id: "cfg1",
    provider: "regional",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveRegion", () => {
  const registration = appDef.dynamicRegistration!;

  it("defaults to the first region", () => {
    expect(resolveRegion(registration)).toBe("us");
  });

  it("honors a hosted region", () => {
    expect(resolveRegion(registration, "eu")).toBe("eu");
  });

  it("falls back for a region the provider does not host", () => {
    // A caller-supplied query param must never reach the endpoint templates
    // unvalidated.
    expect(resolveRegion(registration, "moon")).toBe("us");
  });
});

describe("resolveDynamicClient", () => {
  it("registers a client and caches it on first connect", async () => {
    getAppConfig.mockResolvedValue(null);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ client_id: "minted-1" }),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const resolved = await resolve(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.provider.example/oauth/register");
    expect(JSON.parse(init.body as string)).toEqual({
      client_name: "OneCLI",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "mcp-api.all:read",
    });
    expect(upsertDynamicClientConfig).toHaveBeenCalledWith(
      { projectId: "p1" },
      "regional",
      { clientId: "minted-1", redirectUri: REDIRECT_URI, region: "us" },
    );
    expect(resolved).toEqual({
      values: { clientId: "minted-1", region: "us" },
      source: "app_config",
      registered: true,
    });
  });

  it("reuses the cached client without calling the provider", async () => {
    getAppConfig.mockResolvedValue({
      enabled: true,
      hasCredentials: false,
      settings: {
        clientId: "cached-1",
        redirectUri: REDIRECT_URI,
        region: "us",
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const resolved = await resolve(true);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(resolved?.values).toEqual({ clientId: "cached-1", region: "us" });
    // Nothing was written, so the caller has nothing to audit.
    expect(resolved?.registered).toBe(false);
  });

  it("re-registers when the redirect URI moved", async () => {
    // A client id is only valid for the redirect URIs it was registered with, so
    // a new deployment origin needs a new client.
    getAppConfig.mockResolvedValue({
      enabled: true,
      hasCredentials: false,
      settings: {
        clientId: "cached-1",
        redirectUri: "https://old.example.com/v1/apps/regional/callback",
        region: "us",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({ client_id: "minted-2" }),
      } as Response),
    );

    const resolved = await resolve(true);

    expect(resolved?.values.clientId).toBe("minted-2");
  });

  it("re-registers for a different region", async () => {
    getAppConfig.mockResolvedValue({
      enabled: true,
      hasCredentials: false,
      settings: {
        clientId: "cached-us",
        redirectUri: REDIRECT_URI,
        region: "us",
      },
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ client_id: "minted-eu" }),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const resolved = await resolve(true, "eu");

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.eu.provider.example/oauth/register",
    );
    expect(resolved?.values).toEqual({ clientId: "minted-eu", region: "eu" });
  });

  it("never registers on the callback leg", async () => {
    // The authorization code is bound to the client that started the flow — a
    // fresh client here could only produce a failed exchange.
    getAppConfig.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await resolve(false)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a rejected registration", async () => {
    getAppConfig.mockResolvedValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: async () => ({
          error: "invalid_client_metadata",
          error_description: "redirect_uris: invalid",
        }),
      } as Response),
    );

    await expect(resolve(true)).rejects.toThrow(/redirect_uris: invalid/);
  });
});
