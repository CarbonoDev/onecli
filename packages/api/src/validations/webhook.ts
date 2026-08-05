import { z } from "zod";

import {
  POLL_DEFAULT_WAIT_SEC,
  POLL_MAX_WAIT_SEC,
  QUEUE_DEFAULT_BATCH,
  QUEUE_DEFAULT_LEASE_SEC,
  QUEUE_MAX_BATCH,
  QUEUE_MAX_LEASE_SEC,
  QUEUE_MIN_LEASE_SEC,
  ACK_ERROR_MAX_CHARS,
} from "../services/webhook/constants";
import { VERIFIER_IDS } from "../services/webhook/verifiers";

export const webhookSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "Slug must be lowercase letters, digits and dashes, starting with a letter or digit",
  );

/**
 * Derived from the registry rather than hard-coded, so registering a verifier
 * widens the accepted values with no schema edit.
 */
export const webhookVerificationSchema = z.enum(VERIFIER_IDS);

export const webhookTemplateSchema = z.string().max(8_000);

/**
 * The consumer routing blob. Bounded in size and required to be a JSON object —
 * and validated for NOTHING else. OneCLI never parses this; growing an opinion
 * about its shape here would couple the receiver to one consumer's semantics,
 * which is exactly what the opaque contract exists to prevent.
 */
export const webhookRoutingSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => JSON.stringify(value).length <= 4_000,
    "Routing must be under 4 KB",
  );

const endpointFields = {
  name: z.string().trim().min(1).max(100),
  slug: webhookSlugSchema,
  agentId: z.uuid(),
  verification: webhookVerificationSchema,
  template: webhookTemplateSchema,
  routing: webhookRoutingSchema.nullish(),
  enabled: z.boolean(),
  rateLimitPerMin: z.number().int().min(1).max(6_000),
};

/** Selecting "none" must be a deliberate choice, never a default that slipped. */
const requireUnverifiedAck = <
  T extends { verification?: string; acknowledgeUnverified?: boolean },
>(
  value: T,
) => value.verification !== "none" || value.acknowledgeUnverified === true;

const UNVERIFIED_ACK_MESSAGE =
  'verification "none" requires acknowledgeUnverified: true';

export const createWebhookEndpointSchema = z
  .object({
    ...endpointFields,
    verification: webhookVerificationSchema.default("token"),
    template: webhookTemplateSchema.default(""),
    enabled: z.boolean().default(true),
    rateLimitPerMin: endpointFields.rateLimitPerMin.default(120),
    acknowledgeUnverified: z.boolean().optional(),
  })
  .refine(requireUnverifiedAck, { message: UNVERIFIED_ACK_MESSAGE });

export type CreateWebhookEndpointInput = z.infer<
  typeof createWebhookEndpointSchema
>;

export const updateWebhookEndpointSchema = z
  .object({
    name: endpointFields.name.optional(),
    slug: endpointFields.slug.optional(),
    agentId: endpointFields.agentId.optional(),
    verification: endpointFields.verification.optional(),
    template: endpointFields.template.optional(),
    routing: endpointFields.routing,
    enabled: endpointFields.enabled.optional(),
    rateLimitPerMin: endpointFields.rateLimitPerMin.optional(),
    acknowledgeUnverified: z.boolean().optional(),
  })
  .refine(requireUnverifiedAck, { message: UNVERIFIED_ACK_MESSAGE });

export type UpdateWebhookEndpointInput = z.infer<
  typeof updateWebhookEndpointSchema
>;

/**
 * Consumer long-poll query. Every bound is clamped server-side — the poller's
 * `wait` in particular, because parking longer than the proxy's idle timeout
 * turns an empty batch into a 504.
 */
export const pendingQuerySchema = z.object({
  wait: z.coerce
    .number()
    .int()
    .min(0)
    .max(POLL_MAX_WAIT_SEC)
    .default(POLL_DEFAULT_WAIT_SEC),
  max: z.coerce
    .number()
    .int()
    .min(1)
    .max(QUEUE_MAX_BATCH)
    .default(QUEUE_DEFAULT_BATCH),
  lease: z.coerce
    .number()
    .int()
    .min(QUEUE_MIN_LEASE_SEC)
    .max(QUEUE_MAX_LEASE_SEC)
    .default(QUEUE_DEFAULT_LEASE_SEC),
  /** Opaque poller identity, recorded as `claimedBy` for debugging. */
  poller: z.string().max(64).optional(),
  include: z.enum(["payload", "none"]).default("payload"),
  /** Required only on the project-key auth arm — see middleware/agent-auth. */
  agent: z.string().max(100).optional(),
});

export type PendingQuery = z.infer<typeof pendingQuerySchema>;

/**
 * `retryable` is the consumer's contract for "do not hand this back to me":
 * a routing blob the consumer can't interpret will fail identically forever, so
 * it terminates as `failed` (and stays replayable once a human fixes it) rather
 * than burning the retry budget.
 */
export const ackResultSchema = z.object({
  id: z.uuid(),
  status: z.enum(["ok", "error"]),
  error: z.string().max(ACK_ERROR_MAX_CHARS).optional(),
  retryable: z.boolean().default(true),
});

export const batchAckSchema = z.object({
  claimId: z.uuid(),
  results: z.array(ackResultSchema).min(1).max(QUEUE_MAX_BATCH),
});

export const singleAckSchema = z.object({
  claimId: z.uuid(),
  status: z.enum(["ok", "error"]),
  error: z.string().max(ACK_ERROR_MAX_CHARS).optional(),
  retryable: z.boolean().default(true),
});

export const deliveryStatusSchema = z.enum([
  "pending",
  "delivered",
  "failed",
  "discarded",
]);

/**
 * Delivery-log page. Keyset, not offset: the `{createdAt, id}` pair matches
 * `request-log-service`, the other activity log in this codebase.
 */
export const deliveryListQuerySchema = z.object({
  status: deliveryStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursorCreatedAt: z.iso.datetime().optional(),
  cursorId: z.uuid().optional(),
});

export type DeliveryListQuery = z.infer<typeof deliveryListQuerySchema>;
