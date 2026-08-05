import { githubVerifier } from "./github";
import { noneVerifier } from "./none";
import { tokenVerifier } from "./token";
import type { WebhookVerifier } from "./types";

export type {
  DeliveryDescriptor,
  VerifierContext,
  VerifyFailureReason,
  VerifyResult,
  WebhookVerifier,
} from "./types";

const REGISTRY: Record<string, WebhookVerifier> = {
  [githubVerifier.id]: githubVerifier,
  [tokenVerifier.id]: tokenVerifier,
  [noneVerifier.id]: noneVerifier,
};

/**
 * Non-empty tuple so `z.enum()` accepts it — registering a verifier widens the
 * API's accepted `verification` values with no schema edit.
 */
export const VERIFIER_IDS = Object.keys(REGISTRY) as [string, ...string[]];

export const getVerifier = (id: string): WebhookVerifier | undefined =>
  REGISTRY[id];

/** What the create form needs to render its picker. */
export const listVerifiers = () =>
  Object.values(REGISTRY).map((verifier) => ({
    id: verifier.id,
    label: verifier.label,
    requiresSecret: verifier.requiresSecret,
    /** v1 is manual registration everywhere; the seam is unimplemented. */
    autoSubscribe: Boolean(verifier.subscription),
  }));
