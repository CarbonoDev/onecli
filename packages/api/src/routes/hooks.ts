/**
 * `/v1/hooks` — the public webhook ingest URL, the consumer pull queue, and the
 * project-scoped admin CRUD, in one router.
 *
 * ## Why one router with per-route middleware, and no `use("*")`
 *
 * `Hono.route()` flattens a sub-app's routes into the parent at the mount path,
 * and `app.use("*", mw)` is stored as an ALL-method route at `*`. Mounting a
 * second, authed sub-app at `/hooks` would therefore register an ALL
 * `/hooks/*` middleware in the parent — which would run for the public ingest
 * POST and 401 every provider. So: no `use("*")` in this file, ever, and every
 * non-ingest route names its middleware inline.
 *
 * The cost is that a route added later without its middleware is silently
 * public. `hooks-admin.test.ts` enumerates every route here and asserts 401
 * without credentials. That test is the guard — keep it green.
 *
 * ## Registration order is load-bearing
 *
 * Hono is first-match. `POST /:publicId` (ingest) matches ANY single-segment
 * POST, so it is registered LAST; `POST /ack` would otherwise be swallowed by
 * it and answered 404. Same rule for `GET /:id` versus `GET /pending` and
 * `GET /verifiers`. Add literal paths above the parameterized ones.
 */

import { Hono, type Context } from "hono";

import { agentAuth } from "../middleware/agent-auth";
import { authMiddleware, requireProjectId } from "../middleware/auth";
import { parse } from "./org/parse";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  recordAuditEvent,
} from "../services/audit-service";
import { ServiceError } from "../services/errors";
import {
  getWebhookDelivery,
  listWebhookDeliveries,
  replayWebhookDelivery,
} from "../services/webhook-delivery-service";
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  getWebhookEndpointWithSecret,
  listWebhookEndpoints,
  rotateWebhookSecret,
  updateWebhookEndpoint,
} from "../services/webhook-endpoint-service";
import {
  ingestWebhook,
  type IngestOutcome,
} from "../services/webhook-ingest-service";
import {
  ackDeliveries,
  pollPending,
  type AckResultInput,
} from "../services/webhook-queue-service";
import { WEBHOOK_MAX_BODY_BYTES } from "../services/webhook/constants";
import { listVerifiers } from "../services/webhook/verifiers";
import {
  batchAckSchema,
  createWebhookEndpointSchema,
  deliveryListQuerySchema,
  pendingQuerySchema,
  singleAckSchema,
  updateWebhookEndpointSchema,
} from "../validations/webhook";
import type { ApiEnv } from "../types";

const apiError = (message: string, type = "invalid_request_error") => ({
  error: { message, type },
});

const respondToIngest = (c: Context<ApiEnv>, outcome: IngestOutcome) => {
  switch (outcome.kind) {
    case "queued":
      return c.json({ id: outcome.deliveryId, status: "queued" }, 202);

    // 2xx on purpose. A duplicate is the provider doing exactly what it should
    // — retrying an unacknowledged delivery — and answering 4xx would turn the
    // one case retries exist for into a retry storm.
    case "duplicate":
      return c.json({ id: outcome.deliveryId, status: "duplicate" }, 200);

    case "handshake":
      return c.json({ status: "ignored", reason: "handshake" }, 200);

    // Muting must be invisible to the sender. GitHub disables a webhook that
    // fails continuously, so a 403 here would mean a week-long mute silently
    // breaks the integration and has to be re-enabled on their side too.
    case "disabled":
      return c.json({ status: "ignored", reason: "disabled" }, 200);

    // One message for every verification failure. The specific reason lives on
    // the rejected delivery row, where only a project member can read it.
    case "unverified":
      return c.json(
        apiError("Signature verification failed", "authentication_error"),
        401,
      );

    case "too_large":
      return c.json(apiError("Payload too large"), 413);

    case "bad_json":
      return c.json(apiError("Body is not valid JSON"), 400);

    case "unsupported_media":
      return c.json(apiError("Content-Type must be application/json"), 415);

    case "rate_limited":
      c.header("Retry-After", String(outcome.retryAfterSec));
      return c.json(apiError("Too many requests"), 429);

    // 404 rather than a silent 202. Enumeration is not a real threat against a
    // 128-bit path, whereas a mistyped URL answered 202 debugs for hours while
    // the provider's delivery list stays reassuringly green.
    case "unknown_endpoint":
      return c.json(
        apiError("Webhook endpoint not found", "not_found_error"),
        404,
      );
  }
};

/**
 * Every mutation here audits through `recordAuditEvent`, never `withAudit`.
 *
 * `withAudit` also flushes the Rust gateway's CONNECT cache for the project on
 * every success — the right thing for secrets and policy, which the gateway
 * reads, and pure waste for webhook config, which it does not. Renaming a
 * webhook endpoint should not make every agent in the project re-resolve its
 * credential cache. (It also means a flush failure can't surface as a 500 on a
 * mutation that already committed.)
 */
const auditBase = (c: Context<ApiEnv>) => {
  const auth = c.get("auth");
  return {
    projectId: requireProjectId(auth),
    userId: auth.userId,
    userEmail: auth.userEmail,
    service: AUDIT_SERVICES.WEBHOOK,
    source: AUDIT_SOURCE.API,
  };
};

export const hookRoutes = () => {
  const app = new Hono<ApiEnv>();

  // ── AGENT-AUTH: the consumer pull queue ───────────────────────────────

  app.get("/pending", agentAuth, async (c) => {
    const agent = c.get("agent");
    const query = parse(pendingQuerySchema, c.req.query());

    const claim = await pollPending({
      agentId: agent.agentId,
      agent: { id: agent.agentId, identifier: agent.identifier },
      claimedBy: query.poller ?? "unknown",
      batchSize: query.max,
      leaseSec: query.lease,
      includePayload: query.include === "payload",
      waitSec: query.wait,
      // Client hangup aborts the wait and unsubscribes the notifier.
      signal: c.req.raw.signal,
    });

    // Always 200 with the same shape, never 204: a consumer should not need two
    // code paths to tell "nothing yet" from "here is work".
    c.header("Cache-Control", "no-store");
    return c.json(claim);
  });

  app.post("/ack", agentAuth, async (c) => {
    const agent = c.get("agent");
    const body = await c.req.json().catch(() => null);
    const input = parse(batchAckSchema, body);

    const outcomes = await ackDeliveries({
      agentId: agent.agentId,
      claimId: input.claimId,
      results: input.results as AckResultInput[],
    });

    // A wholly stale batch means the poller lost its entire lease; say so
    // loudly rather than letting it believe its work landed.
    if (outcomes.every((outcome) => outcome.outcome === "stale")) {
      throw new ServiceError("CONFLICT", "Claim expired or superseded");
    }
    return c.json({ acked: outcomes });
  });

  app.post("/deliveries/:deliveryId/ack", agentAuth, async (c) => {
    const agent = c.get("agent");
    const body = await c.req.json().catch(() => null);
    const input = parse(singleAckSchema, body);

    const [outcome] = await ackDeliveries({
      agentId: agent.agentId,
      claimId: input.claimId,
      results: [
        {
          id: c.req.param("deliveryId"),
          status: input.status,
          error: input.error,
          retryable: input.retryable,
        },
      ],
    });

    if (!outcome || outcome.outcome === "stale") {
      throw new ServiceError("CONFLICT", "Claim expired or superseded");
    }
    return c.json(outcome);
  });

  // ── PROJECT-AUTH: admin CRUD ──────────────────────────────────────────

  app.get("/verifiers", authMiddleware, (c) => c.json(listVerifiers()));

  app.get("/deliveries/:deliveryId", authMiddleware, async (c) => {
    const projectId = requireProjectId(c.get("auth"));
    return c.json(
      await getWebhookDelivery(projectId, c.req.param("deliveryId")),
    );
  });

  app.post("/deliveries/:deliveryId/replay", authMiddleware, async (c) => {
    const projectId = requireProjectId(c.get("auth"));
    const replayed = await replayWebhookDelivery(
      projectId,
      c.req.param("deliveryId"),
    );

    // `recordAuditEvent`, not `withAudit`, deliberately: withAudit flushes the
    // gateway config cache on every success, and a webhook replay is not
    // gateway state. A bulk replay would flush it once per delivery for nothing.
    await recordAuditEvent({
      ...auditBase(c),
      action: AUDIT_ACTIONS.CREATE,
      metadata: {
        deliveryId: replayed.id,
        replayOfId: replayed.replayOfId,
        endpointId: replayed.endpointId,
      },
    });
    return c.json(replayed, 201);
  });

  app.get("/", authMiddleware, async (c) => {
    const projectId = requireProjectId(c.get("auth"));
    return c.json(await listWebhookEndpoints(projectId));
  });

  app.post("/", authMiddleware, async (c) => {
    const projectId = requireProjectId(c.get("auth"));
    const body = await c.req.json().catch(() => null);
    const input = parse(createWebhookEndpointSchema, body);

    const endpoint = await createWebhookEndpoint(projectId, input);
    await recordAuditEvent({
      ...auditBase(c),
      action: AUDIT_ACTIONS.CREATE,
      metadata: {
        endpointId: endpoint.id,
        slug: endpoint.slug,
        verification: endpoint.verification,
        agentId: endpoint.agentId,
      },
    });
    return c.json(endpoint, 201);
  });

  app.get("/:hookId", authMiddleware, async (c) => {
    const projectId = requireProjectId(c.get("auth"));
    return c.json(
      await getWebhookEndpointWithSecret(projectId, c.req.param("hookId")),
    );
  });

  app.get("/:hookId/deliveries", authMiddleware, async (c) => {
    const projectId = requireProjectId(c.get("auth"));
    const query = parse(deliveryListQuerySchema, c.req.query());
    return c.json(
      await listWebhookDeliveries(projectId, c.req.param("hookId"), query),
    );
  });

  app.patch("/:hookId", authMiddleware, async (c) => {
    const projectId = requireProjectId(c.get("auth"));
    const hookId = c.req.param("hookId");
    const body = await c.req.json().catch(() => null);
    const input = parse(updateWebhookEndpointSchema, body);

    const endpoint = await updateWebhookEndpoint(projectId, hookId, input);
    await recordAuditEvent({
      ...auditBase(c),
      action: AUDIT_ACTIONS.UPDATE,
      metadata: {
        endpointId: endpoint.id,
        slug: endpoint.slug,
        verification: endpoint.verification,
        agentId: endpoint.agentId,
      },
    });
    return c.json(endpoint);
  });

  app.delete("/:hookId", authMiddleware, async (c) => {
    const projectId = requireProjectId(c.get("auth"));
    const hookId = c.req.param("hookId");

    const result = await deleteWebhookEndpoint(projectId, hookId);
    await recordAuditEvent({
      ...auditBase(c),
      action: AUDIT_ACTIONS.DELETE,
      metadata: {
        endpointId: result.id,
        slug: result.slug,
        // A count, never the ids — the house convention for cascades.
        deletedDeliveries: result.deletedDeliveries,
      },
    });
    return c.json(result);
  });

  app.post("/:hookId/rotate-secret", authMiddleware, async (c) => {
    const projectId = requireProjectId(c.get("auth"));
    const hookId = c.req.param("hookId");

    const rotated = await rotateWebhookSecret(projectId, hookId);
    await recordAuditEvent({
      ...auditBase(c),
      action: AUDIT_ACTIONS.REGENERATE,
      metadata: { endpointId: rotated.id, slug: rotated.slug },
    });
    return c.json(rotated);
  });

  // ── PUBLIC: ingest. No middleware; trust comes from the signature. ─────
  // LAST on purpose: `/:publicId` matches any single-segment POST, so every
  // literal POST above must be registered before it.
  app.post("/:publicId", async (c) => {
    // Checked before touching the stream so a 25 MB body is refused rather
    // than buffered. A lying content-length is caught by the byte check in the
    // service.
    const declared = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > WEBHOOK_MAX_BODY_BYTES) {
      return c.json(apiError("Payload too large"), 413);
    }

    // Read ONCE, as bytes. The verifier must see exactly what the provider
    // signed — a re-serialized parse changes key order and whitespace — and
    // owning the parse means the JSON error is ours to shape.
    let rawBody: Buffer;
    try {
      rawBody = Buffer.from(await c.req.arrayBuffer());
    } catch {
      return c.json(apiError("Could not read request body"), 400);
    }

    const outcome = await ingestWebhook({
      publicId: c.req.param("publicId"),
      rawBody,
      headers: c.req.raw.headers,
      query: new URL(c.req.url).searchParams,
      contentType: c.req.header("content-type") ?? null,
    });

    return respondToIngest(c, outcome);
  });

  return app;
};
