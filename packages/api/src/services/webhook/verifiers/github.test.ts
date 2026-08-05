import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { githubVerifier } from "./github";
import type { VerifierContext } from "./types";

const SECRET = "whsec_test";

const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex")}`;

const ctx = (
  body: string,
  headers: Record<string, string>,
  secret: string | null = SECRET,
): VerifierContext => ({
  rawBody: Buffer.from(body, "utf8"),
  headers: new Headers(headers),
  query: new URLSearchParams(),
  secret,
});

describe("githubVerifier.verify", () => {
  it("accepts a correct signature", () => {
    const body = '{"action":"opened"}';
    const result = githubVerifier.verify(
      ctx(body, { "x-hub-signature-256": sign(body) }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects a one-byte change to the body", () => {
    const body = '{"action":"opened"}';
    const result = githubVerifier.verify(
      ctx('{"action":"closed"}', { "x-hub-signature-256": sign(body) }),
    );
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a correct digest under the wrong algorithm prefix", () => {
    const body = "{}";
    const digest = sign(body).slice("sha256=".length);
    const result = githubVerifier.verify(
      ctx(body, { "x-hub-signature-256": `sha1=${digest}` }),
    );
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  // timingSafeEqual throws on unequal buffer lengths — without the length guard
  // this would be a 500 instead of a 401.
  it("rejects a truncated signature without throwing", () => {
    const body = "{}";
    const result = githubVerifier.verify(
      ctx(body, { "x-hub-signature-256": sign(body).slice(0, 20) }),
    );
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("reports a missing header separately from a bad one", () => {
    expect(githubVerifier.verify(ctx("{}", {}))).toEqual({
      ok: false,
      reason: "missing_signature",
    });
  });

  it("fails closed when the endpoint stores no secret", () => {
    const body = "{}";
    expect(
      githubVerifier.verify(
        ctx(body, { "x-hub-signature-256": sign(body) }, null),
      ),
    ).toEqual({ ok: false, reason: "missing_secret" });
  });

  // The digest is over the bytes as sent, so anything that re-serializes the
  // parse — key reordering, unicode escaping — breaks it.
  it("signs bytes, not a re-serialization", () => {
    const body = '{ "b": 1, "a": "café" }';
    const reserialized = JSON.stringify(JSON.parse(body));
    expect(reserialized).not.toBe(body);

    expect(
      githubVerifier.verify(ctx(body, { "x-hub-signature-256": sign(body) })),
    ).toEqual({ ok: true });
    expect(
      githubVerifier.verify(
        ctx(reserialized, { "x-hub-signature-256": sign(body) }),
      ),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("githubVerifier.describe", () => {
  const headers = (values: Record<string, string>) => new Headers(values);

  it("joins the event and the action", () => {
    expect(
      githubVerifier.describe(headers({ "x-github-event": "issues" }), {
        action: "opened",
      }),
    ).toEqual({ eventType: "issues.opened", dedupeKey: null });
  });

  it("uses the bare event when there is no action", () => {
    expect(
      githubVerifier.describe(headers({ "x-github-event": "push" }), {}),
    ).toMatchObject({ eventType: "push" });
  });

  it("ignores a non-string action", () => {
    expect(
      githubVerifier.describe(headers({ "x-github-event": "issues" }), {
        action: 7,
      }),
    ).toMatchObject({ eventType: "issues" });
  });

  it("takes the dedupe key from X-GitHub-Delivery", () => {
    expect(
      githubVerifier.describe(
        headers({ "x-github-event": "push", "x-github-delivery": "abc-123" }),
        {},
      ),
    ).toEqual({ eventType: "push", dedupeKey: "abc-123" });
  });
});

describe("githubVerifier.isHandshake", () => {
  it("is true only for ping", () => {
    expect(
      githubVerifier.isHandshake?.(
        new Headers({ "x-github-event": "ping" }),
        {},
      ),
    ).toBe(true);
    expect(
      githubVerifier.isHandshake?.(
        new Headers({ "x-github-event": "push" }),
        {},
      ),
    ).toBe(false);
  });
});
