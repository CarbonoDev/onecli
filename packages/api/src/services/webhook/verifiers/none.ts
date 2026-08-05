import type { WebhookVerifier } from "./types";

const readString = (payload: unknown, key: string): string | null => {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
};

/**
 * No verification: the URL itself is the credential.
 *
 * Defensible only because `publicId` is 128 bits of CSPRNG in the path — anyone
 * holding the URL can post, so it must be treated like a secret and never
 * appear in a bug report or a screenshot. Selecting it requires an explicit
 * `acknowledgeUnverified` in the create payload precisely so it can't be
 * chosen by accident.
 */
export const noneVerifier: WebhookVerifier = {
  id: "none",
  label: "None (URL is the secret)",
  requiresSecret: false,

  verify: () => ({ ok: true }),

  describe(headers, payload) {
    return {
      eventType: headers.get("x-event-type") ?? readString(payload, "event"),
      dedupeKey: headers.get("x-delivery-id") ?? headers.get("idempotency-key"),
    };
  },
};
