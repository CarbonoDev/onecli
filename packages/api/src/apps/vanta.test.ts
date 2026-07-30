import { afterEach, describe, expect, it, vi } from "vitest";
import { vanta, vantaMcpHost } from "./vanta";

const oauth = () => {
  if (vanta.connectionMethod.type !== "oauth") {
    throw new Error("vanta should connect via OAuth");
  }
  return vanta.connectionMethod;
};

const authUrl = (
  appCredentials: Record<string, string>,
  codeChallenge?: string,
) =>
  new URL(
    oauth().buildAuthUrl({
      appCredentials,
      redirectUri: "https://api.example.com/v1/apps/vanta/callback",
      scopes: oauth().defaultScopes ?? [],
      state: "signed-state",
      ...(codeChallenge ? { codeChallenge } : {}),
    }),
  );

const tokenResponse = (body: unknown, ok = true) =>
  ({
    ok,
    status: ok ? 200 : 400,
    json: async () => body,
  }) as Response;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("vanta buildAuthUrl", () => {
  it("authorizes against the region's host with PKCE and a resource indicator", () => {
    const url = authUrl({ clientId: "client-123", region: "us" }, "challenge");

    expect(url.origin + url.pathname).toBe(
      "https://app.vanta.com/oauth/authorize",
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "client-123",
      response_type: "code",
      redirect_uri: "https://api.example.com/v1/apps/vanta/callback",
      scope: "mcp-api.all:read mcp-api.all:write",
      state: "signed-state",
      code_challenge: "challenge",
      code_challenge_method: "S256",
      resource: "https://mcp.vanta.com",
    });
  });

  it("uses the regional hosts for eu and aus", () => {
    expect(authUrl({ clientId: "c", region: "eu" }, "challenge").host).toBe(
      "app.eu.vanta.com",
    );
    expect(
      authUrl({ clientId: "c", region: "aus" }, "challenge").searchParams.get(
        "resource",
      ),
    ).toBe("https://mcp.aus.vanta.com");
  });

  it("refuses to build a URL without a PKCE challenge", () => {
    // Vanta issues no client secret, so PKCE is the only proof of the flow.
    expect(() => authUrl({ clientId: "c", region: "us" })).toThrow(/PKCE/);
  });

  it("refuses to build a URL before a client is registered", () => {
    expect(() => authUrl({ region: "us" }, "challenge")).toThrow(
      /not registered/,
    );
  });
});

describe("vanta exchangeCode", () => {
  const exchange = (
    overrides: {
      appCredentials?: Record<string, string>;
      callbackParams?: Record<string, string>;
      codeVerifier?: string;
    } = {},
  ) =>
    oauth().exchangeCode({
      appCredentials: { clientId: "client-123", region: "us" },
      callbackParams: { code: "auth-code" },
      redirectUri: "https://api.example.com/v1/apps/vanta/callback",
      codeVerifier: "verifier",
      ...overrides,
    });

  it("exchanges the code and stores what the gateway needs to refresh", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      tokenResponse({
        access_token: "at-1",
        refresh_token: "rt-1",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "mcp-api.all:read mcp-api.all:write",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await exchange();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.vanta.com/oauth/token");
    const body = new URLSearchParams(init.body as string);
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "authorization_code",
      code: "auth-code",
      redirect_uri: "https://api.example.com/v1/apps/vanta/callback",
      client_id: "client-123",
      code_verifier: "verifier",
      resource: "https://mcp.vanta.com",
    });

    expect(result.credentials).toMatchObject({
      access_token: "at-1",
      refresh_token: "rt-1",
      client_id: "client-123",
      token_url: "https://api.vanta.com/oauth/token",
      mcp_host: "mcp.vanta.com",
      region: "us",
    });
    expect(result.credentials.expires_at).toBeGreaterThan(
      Math.floor(Date.now() / 1000),
    );
    // No `type`: the gateway's refresh_token path handles this credential, not
    // one of the special-cased credential types.
    expect(result.credentials.type).toBeUndefined();
    expect(result.scopes).toEqual(["mcp-api.all:read", "mcp-api.all:write"]);
    expect(result.metadata).toMatchObject({ region: "us", name: "Vanta (US)" });
  });

  it("binds credentials to the region's token endpoint and MCP host", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          tokenResponse({ access_token: "at", refresh_token: "rt" }),
        ),
    );

    const result = await exchange({
      appCredentials: { clientId: "c", region: "eu" },
    });

    expect(result.credentials).toMatchObject({
      token_url: "https://api.eu.vanta.com/oauth/token",
      mcp_host: "mcp.eu.vanta.com",
    });
  });

  it("surfaces a denied consent screen", async () => {
    await expect(
      exchange({
        callbackParams: {
          error: "access_denied",
          error_description: "User denied",
        },
      }),
    ).rejects.toThrow(/access_denied/);
  });

  it("requires the PKCE verifier from the authorize leg", async () => {
    await expect(exchange({ codeVerifier: undefined })).rejects.toThrow(
      /PKCE verifier/,
    );
  });

  it("reports a token endpoint failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          tokenResponse(
            { error: "invalid_grant", error_description: "code expired" },
            false,
          ),
        ),
    );

    await expect(exchange()).rejects.toThrow(/code expired/);
  });
});

describe("vantaMcpHost", () => {
  it("maps regions to MCP hosts", () => {
    expect(vantaMcpHost("us")).toBe("mcp.vanta.com");
    expect(vantaMcpHost("eu")).toBe("mcp.eu.vanta.com");
    expect(vantaMcpHost("aus")).toBe("mcp.aus.vanta.com");
  });
});

describe("vanta app definition", () => {
  it("registers its OAuth client dynamically instead of asking for BYOC", () => {
    // Vanta's authorization server advertises
    // `token_endpoint_auth_methods_supported: ["none"]` — there is no secret to
    // configure, so `configurable` must stay unset or the connect UI would gate
    // on credentials that can never be supplied.
    expect(vanta.configurable).toBeUndefined();
    expect(vanta.dynamicRegistration?.regions).toEqual(["us", "eu", "aus"]);
    expect(vanta.dynamicRegistration?.registrationUrl("eu")).toBe(
      "https://api.eu.vanta.com/oauth/register",
    );
    expect(oauth().pkce).toBe(true);
  });
});
