/**
 * The public ingest path: verify, record, render, queue.
 *
 * Two properties drive the whole shape of this file.
 *
 * 1. **It runs unauthenticated.** Every step is ordered cheapest-fail-first so
 *    a scanner costs a regex, not a decrypt. Nothing derived from the request
 *    is trusted before `verify()` returns ok.
 * 2. **It must ack fast.** GitHub gives a webhook ~10s before it records a
 *    failure, and repeated failures get the hook disabled on their side. So the
 *    work here is one indexed SELECT, one decrypt, one HMAC, one parse and one
 *    INSERT — and everything that can happen afterwards (waking pollers,
 *    touching the endpoint) is fire-and-forget.
 */

import { randomUUID } from "node:crypto";

import { db, Prisma } from "@onecli/db";

import { logger } from "../lib/logger";
import { consumeRateLimit } from "../lib/rate-limit";
import { getCrypto } from "../providers";
import {
  DELIVERY_STATUS,
  DISCARD_REASON,
  HEADER_ALLOWLIST,
  WEBHOOK_MAX_BODY_BYTES,
  WEBHOOK_PUBLIC_ID_RE,
} from "./webhook/constants";
import { notifyPending } from "./webhook/notify";
import { renderTemplate } from "./webhook/render";
import { getVerifier } from "./webhook/verifiers";
import { touchLastDeliveryAt } from "./webhook-endpoint-service";
import { maybeSweep } from "./webhook-retention-service";

export type IngestOutcome =
  | { kind: "queued"; deliveryId: string }
  | { kind: "duplicate"; deliveryId: string | null }
  | { kind: "handshake" }
  | { kind: "disabled" }
  | { kind: "unknown_endpoint" }
  | { kind: "unverified"; reason: string }
  | { kind: "too_large" }
  | { kind: "bad_json" }
  | { kind: "unsupported_media" }
  | { kind: "rate_limited"; retryAfterSec: number };

export interface IngestArgs {
  publicId: string;
  rawBody: Buffer;
  headers: Headers;
  query: URLSearchParams;
  contentType: string | null;
}

const log = logger.child({ module: "webhook-ingest" });

const pickHeaders = (headers: Headers): Record<string, string> => {
  const picked: Record<string, string> = {};
  for (const name of HEADER_ALLOWLIST) {
    const value = headers.get(name);
    if (value !== null) picked[name] = value;
  }
  return picked;
};

type ParseResult =
  | { ok: true; payload: unknown }
  | { ok: false; kind: "bad_json" | "unsupported_media" };

/**
 * GitHub can be configured to send `application/x-www-form-urlencoded`, where
 * the JSON body arrives in a `payload` field — and the signature still covers
 * the raw form bytes, which is why verification happens before this runs.
 */
const parseBody = (
  rawBody: Buffer,
  contentType: string | null,
): ParseResult => {
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const text = rawBody.toString("utf8");

  if (type === "application/x-www-form-urlencoded") {
    const field = new URLSearchParams(text).get("payload");
    if (field === null) return { ok: false, kind: "bad_json" };
    try {
      return { ok: true, payload: JSON.parse(field) };
    } catch {
      return { ok: false, kind: "bad_json" };
    }
  }

  const jsonish =
    type === "" || type.includes("json") || type.startsWith("text/");
  if (!jsonish) return { ok: false, kind: "unsupported_media" };

  try {
    return { ok: true, payload: JSON.parse(text) };
  } catch {
    return { ok: false, kind: "bad_json" };
  }
};

const isDedupeViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2002" &&
  JSON.stringify(error.meta?.target ?? "").includes("dedupe");

/** Never awaited by the request: a failure here must not fail an ingest. */
const afterIngest = (endpointId: string, agentId: string | null) => {
  if (agentId) notifyPending(agentId);
  void touchLastDeliveryAt(endpointId).catch((err: unknown) => {
    log.error({ err, endpointId }, "failed to touch webhook endpoint");
  });
  // There is no scheduler in this deployment; the ingest path is the only thing
  // that runs often enough to hang retention off. Throttled to once per
  // interval per process, and never awaited.
  maybeSweep();
};

export const ingestWebhook = async ({
  publicId,
  rawBody,
  headers,
  query,
  contentType,
}: IngestArgs): Promise<IngestOutcome> => {
  // Costs nothing, and keeps a stray admin-shaped path from ever reaching a
  // database lookup.
  if (!WEBHOOK_PUBLIC_ID_RE.test(publicId)) return { kind: "unknown_endpoint" };
  if (rawBody.byteLength > WEBHOOK_MAX_BODY_BYTES) return { kind: "too_large" };

  const endpoint = await db.webhookEndpoint.findUnique({
    where: { publicId },
    select: {
      id: true,
      projectId: true,
      agentId: true,
      slug: true,
      verification: true,
      secret: true,
      template: true,
      enabled: true,
      rateLimitPerMin: true,
    },
  });
  if (!endpoint) return { kind: "unknown_endpoint" };

  const limit = consumeRateLimit(`hook:${publicId}`, endpoint.rateLimitPerMin);
  if (!limit.allowed) {
    return { kind: "rate_limited", retryAfterSec: limit.retryAfterSec };
  }

  const storedHeaders = pickHeaders(headers);

  // A muted endpoint must look healthy to the sender — see the route's status
  // table for why. No row: a mute that fills the log is a mute nobody uses.
  if (!endpoint.enabled) return { kind: "disabled" };

  const verifier = getVerifier(endpoint.verification);
  // Fail closed: a row whose verifier was removed from the registry must never
  // ingest on the strength of the missing check.
  if (!verifier) {
    log.error(
      { endpointId: endpoint.id, verification: endpoint.verification },
      "webhook endpoint references an unknown verifier",
    );
    return { kind: "unverified", reason: "unknown_verifier" };
  }

  let secret: string | null = null;
  if (endpoint.secret) {
    try {
      secret = await getCrypto().decrypt(endpoint.secret);
    } catch (err) {
      log.error({ err, endpointId: endpoint.id }, "failed to decrypt secret");
      return { kind: "unverified", reason: "secret_unavailable" };
    }
  }

  const verification = verifier.verify({ rawBody, headers, query, secret });
  if (!verification.ok) {
    // Recorded without the payload: an unverified caller must not be able to
    // write arbitrary bytes into the log. The row exists so "GitHub says 401"
    // is diagnosable from the dashboard.
    await recordDiscarded({
      endpoint,
      headers: storedHeaders,
      bodyBytes: rawBody.byteLength,
      reason: DISCARD_REASON.REJECTED,
      lastError: verification.reason,
      payload: null,
    });
    return { kind: "unverified", reason: verification.reason };
  }

  const parsed = parseBody(rawBody, contentType);
  if (!parsed.ok) return { kind: parsed.kind };

  if (verifier.isHandshake?.(headers, parsed.payload)) {
    await recordDiscarded({
      endpoint,
      headers: storedHeaders,
      bodyBytes: rawBody.byteLength,
      reason: DISCARD_REASON.HANDSHAKE,
      lastError: null,
      payload: parsed.payload,
    });
    return { kind: "handshake" };
  }

  const descriptor = verifier.describe(headers, parsed.payload);
  // Pre-generated so `{{$delivery_id}}` matches the row's primary key.
  const deliveryId = randomUUID();
  const rendered = renderTemplate(endpoint.template, {
    payload: parsed.payload,
    rawBody: rawBody.toString("utf8"),
    slug: endpoint.slug,
    event: descriptor.eventType,
    deliveryId,
  });

  try {
    await db.webhookDelivery.create({
      data: {
        id: deliveryId,
        projectId: endpoint.projectId,
        endpointId: endpoint.id,
        agentId: endpoint.agentId,
        status: DELIVERY_STATUS.PENDING,
        eventType: descriptor.eventType,
        dedupeKey: descriptor.dedupeKey,
        payload: parsed.payload as Prisma.InputJsonValue,
        headers: storedHeaders,
        bodyBytes: rawBody.byteLength,
        renderedText: rendered.text,
        renderWarnings: rendered.unresolved,
      },
    });
  } catch (error) {
    // Caught rather than pre-checked: a read-then-write loses the race against
    // a provider retrying concurrently, which is the exact case dedup is for.
    if (isDedupeViolation(error)) {
      const original = await db.webhookDelivery.findFirst({
        where: { endpointId: endpoint.id, dedupeKey: descriptor.dedupeKey },
        select: { id: true },
      });
      if (original) {
        await db.webhookDelivery.update({
          where: { id: original.id },
          data: { duplicateCount: { increment: 1 } },
        });
      }
      return { kind: "duplicate", deliveryId: original?.id ?? null };
    }
    throw error;
  }

  afterIngest(endpoint.id, endpoint.agentId);
  return { kind: "queued", deliveryId };
};

interface DiscardArgs {
  endpoint: { id: string; projectId: string; agentId: string };
  headers: Record<string, string>;
  bodyBytes: number;
  reason: string;
  lastError: string | null;
  payload: unknown;
}

const recordDiscarded = async ({
  endpoint,
  headers,
  bodyBytes,
  reason,
  lastError,
  payload,
}: DiscardArgs): Promise<void> => {
  try {
    await db.webhookDelivery.create({
      data: {
        projectId: endpoint.projectId,
        endpointId: endpoint.id,
        agentId: endpoint.agentId,
        status: DELIVERY_STATUS.DISCARDED,
        discardReason: reason,
        headers,
        bodyBytes,
        lastError,
        payload:
          payload === null
            ? Prisma.JsonNull
            : (payload as Prisma.InputJsonValue),
      },
    });
  } catch (err) {
    // Best effort: failing to log a rejected request must not turn into a 500
    // that a scanner can trigger at will.
    log.error(
      { err, endpointId: endpoint.id, reason },
      "failed to record discarded delivery",
    );
  }
};
