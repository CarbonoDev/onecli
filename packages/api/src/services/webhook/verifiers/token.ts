import { safeEqual, type WebhookVerifier } from "./types";

const bearer = (value: string | null): string | null => {
  const match = /^Bearer\s+(.+)$/i.exec(value?.trim() ?? "");
  return match?.[1] ?? null;
};

const readString = (payload: unknown, key: string): string | null => {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
};

/**
 * The generic sender: a shared secret presented in a header, as a bearer token,
 * or as `?token=` for senders that can only configure a URL.
 *
 * Weaker than an HMAC — the secret travels with every request, so a proxy log
 * on the way in captures it — but it is what most alerting tools can actually
 * emit, and TLS covers the wire.
 */
export const tokenVerifier: WebhookVerifier = {
  id: "token",
  label: "Shared token",
  requiresSecret: true,

  verify({ headers, query, secret }) {
    if (!secret) return { ok: false, reason: "missing_secret" };
    const provided =
      headers.get("x-webhook-token") ??
      bearer(headers.get("authorization")) ??
      query.get("token");
    if (!provided) return { ok: false, reason: "missing_signature" };

    return safeEqual(provided, secret)
      ? { ok: true }
      : { ok: false, reason: "bad_signature" };
  },

  describe(headers, payload) {
    return {
      eventType:
        headers.get("x-event-type") ??
        readString(payload, "event") ??
        readString(payload, "type"),
      dedupeKey: headers.get("x-delivery-id") ?? headers.get("idempotency-key"),
    };
  },
};
