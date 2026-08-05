import { describe, expect, it } from "vitest";

import { noneVerifier } from "./none";
import { tokenVerifier } from "./token";
import type { VerifierContext } from "./types";

const SECRET = "whsec_shared";

const ctx = (
  headers: Record<string, string> = {},
  query = "",
  secret: string | null = SECRET,
): VerifierContext => ({
  rawBody: Buffer.from("{}", "utf8"),
  headers: new Headers(headers),
  query: new URLSearchParams(query),
  secret,
});

describe("tokenVerifier.verify", () => {
  it("accepts the secret in X-Webhook-Token", () => {
    expect(tokenVerifier.verify(ctx({ "x-webhook-token": SECRET }))).toEqual({
      ok: true,
    });
  });

  it("accepts the secret as a bearer token", () => {
    expect(
      tokenVerifier.verify(ctx({ authorization: `Bearer ${SECRET}` })),
    ).toEqual({ ok: true });
  });

  it("accepts the secret in the query string", () => {
    expect(tokenVerifier.verify(ctx({}, `token=${SECRET}`))).toEqual({
      ok: true,
    });
  });

  it("rejects a wrong secret", () => {
    expect(tokenVerifier.verify(ctx({ "x-webhook-token": "nope" }))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a secret of a different length without throwing", () => {
    expect(
      tokenVerifier.verify(ctx({ "x-webhook-token": `${SECRET}extra` })),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("reports a missing token separately", () => {
    expect(tokenVerifier.verify(ctx())).toEqual({
      ok: false,
      reason: "missing_signature",
    });
  });

  it("fails closed when the endpoint stores no secret", () => {
    expect(
      tokenVerifier.verify(ctx({ "x-webhook-token": SECRET }, "", null)),
    ).toEqual({ ok: false, reason: "missing_secret" });
  });
});

describe("tokenVerifier.describe", () => {
  it("prefers the header event, then the payload", () => {
    expect(
      tokenVerifier.describe(new Headers({ "x-event-type": "alert" }), {
        event: "ignored",
      }),
    ).toMatchObject({ eventType: "alert" });

    expect(
      tokenVerifier.describe(new Headers(), { event: "alert" }),
    ).toMatchObject({ eventType: "alert" });
  });

  it("reads the dedupe key from either header", () => {
    expect(
      tokenVerifier.describe(new Headers({ "idempotency-key": "k1" }), {}),
    ).toMatchObject({ dedupeKey: "k1" });
  });
});

describe("noneVerifier", () => {
  it("always verifies and requires no secret", () => {
    expect(noneVerifier.requiresSecret).toBe(false);
    expect(noneVerifier.verify(ctx({}, "", null))).toEqual({ ok: true });
  });
});
