import { createHmac } from "node:crypto";

import { safeEqual, type WebhookVerifier } from "./types";

const SIGNATURE_HEADER = "x-hub-signature-256";

const readString = (payload: unknown, key: string): string | null => {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
};

/**
 * GitHub webhooks: HMAC-SHA256 of the raw body, hex, prefixed `sha256=`.
 *
 * The digest is over the bytes as sent — GitHub signs the form-encoded body too
 * when the hook is configured that way, which is why the caller must hand us
 * `rawBody` and not a re-serialization of the parse.
 */
export const githubVerifier: WebhookVerifier = {
  id: "github",
  label: "GitHub",
  requiresSecret: true,

  verify({ rawBody, headers, secret }) {
    if (!secret) return { ok: false, reason: "missing_secret" };
    const provided = headers.get(SIGNATURE_HEADER);
    if (!provided) return { ok: false, reason: "missing_signature" };

    const expected = `sha256=${createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex")}`;

    // Compares the whole `sha256=…` string, so a correct digest under the wrong
    // algorithm prefix fails too.
    return safeEqual(provided, expected)
      ? { ok: true }
      : { ok: false, reason: "bad_signature" };
  },

  describe(headers, payload) {
    const event = headers.get("x-github-event");
    const action = readString(payload, "action");
    return {
      eventType: event ? (action ? `${event}.${action}` : event) : null,
      dedupeKey: headers.get("x-github-delivery"),
    };
  },

  isHandshake: (headers) => headers.get("x-github-event") === "ping",
};
