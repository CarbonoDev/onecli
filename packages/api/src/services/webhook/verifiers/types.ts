/**
 * The verifier registry contract.
 *
 * A verifier answers three questions about an inbound request: is it authentic,
 * what event is it, and does it carry a provider-side delivery id we can dedupe
 * on. Keyed by a plain string (`WebhookEndpoint.verification`) rather than an
 * enum so adding a provider is a code-only change — no migration, and the Zod
 * schema widens automatically off `VERIFIER_IDS`.
 */

import { timingSafeEqual } from "node:crypto";

export interface VerifierContext {
  /**
   * The exact bytes the provider signed. Never a re-serialized parse — key
   * order and whitespace both change the digest.
   */
  rawBody: Buffer;
  headers: Headers;
  query: URLSearchParams;
  /** Already decrypted by the caller; null when the endpoint stores none. */
  secret: string | null;
}

export type VerifyFailureReason =
  | "missing_signature"
  | "bad_signature"
  | "missing_secret";

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: VerifyFailureReason };

export interface DeliveryDescriptor {
  /** Rendered as `{{$event}}`, e.g. "issues.opened". */
  eventType: string | null;
  /** The provider's own delivery id; the dedup key. */
  dedupeKey: string | null;
}

export interface WebhookVerifier {
  /** Stored verbatim in `WebhookEndpoint.verification`. */
  readonly id: string;
  readonly label: string;
  readonly requiresSecret: boolean;
  /** Signature check over the raw body. Pure, synchronous, no I/O. */
  verify(ctx: VerifierContext): VerifyResult;
  /** Runs after verify + JSON parse. */
  describe(headers: Headers, payload: unknown): DeliveryDescriptor;
  /**
   * A provider handshake (GitHub's `ping`): recorded so "the hook is wired up"
   * is visible in the log, but never queued for an agent.
   */
  isHandshake?(headers: Headers, payload: unknown): boolean;

  /**
   * v2 seam, unimplemented in v1. When a verifier grows this, the admin API can
   * create and remove the hook on the provider's side through a stored
   * `AppConnection` and persist the result into
   * `WebhookEndpoint.subscriptionState` — which is why that column exists now.
   * Adding provider-native subscription is then code-only.
   */
  readonly subscription?: {
    create(args: {
      connectionId: string;
      ingestUrl: string;
      secret: string;
    }): Promise<{ state: unknown }>;
    remove(args: { connectionId: string; state: unknown }): Promise<void>;
  };
}

/**
 * Constant-time string compare that tolerates unequal lengths.
 *
 * `timingSafeEqual` throws when the buffers differ in size, so the length guard
 * is not an optimization — without it a truncated signature is a 500 instead of
 * a 401. Same shape as `middleware/internal-auth.ts`.
 */
export const safeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
};
