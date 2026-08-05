import { randomBytes } from "node:crypto";

import { WEBHOOK_PUBLIC_ID_PREFIX, WEBHOOK_SECRET_PREFIX } from "./constants";

/**
 * The unguessable path segment of an endpoint's ingest URL.
 *
 * 128 bits of CSPRNG. This is not a display id — it is the only thing standing
 * between an unauthenticated POST and an endpoint, and for `verification:
 * "none"` it is the *entire* credential. Deliberately not `lib/ids.ts`, whose
 * nanoid alphabet and length are sized for readable project slugs.
 */
export const generateWebhookPublicId = (): string =>
  `${WEBHOOK_PUBLIC_ID_PREFIX}${randomBytes(16).toString("hex")}`;

/** The HMAC / shared secret pasted into the provider's config. */
export const generateWebhookSecret = (): string =>
  `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString("hex")}`;
