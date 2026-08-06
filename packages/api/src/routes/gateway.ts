import { Hono } from "hono";
import { GATEWAY_API_URL } from "../lib/env";
import { loadCaCertificate } from "../lib/gateway-ca";
import { mintClientCert } from "../lib/gateway-client-cert";
import { authMiddleware, requireProjectId } from "../middleware/auth";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
} from "../services/audit-service";
import {
  ensureClientHost,
  stampClientHostIssued,
} from "../services/client-host-service";
import { ServiceError } from "../services/errors";
import type { ApiEnv } from "../types";
import { clientCertEnrollSchema } from "../validations/client-cert";

// Public discovery endpoint — no auth, mirroring the `/gateway/ca` sibling
// below. It returns only the deployment's gateway proxy URL: a static,
// per-deployment config value (identical for every caller, not a secret) that
// clients need to bootstrap BEFORE they hold a project or org context. Guarding
// it with the project-requiring auth middleware 401'd onprem-slim clients, whose
// only credential at discovery time is an org key carrying no project.
export const gatewayUrlRoutes = () => {
  const app = new Hono();

  app.get("/", (c) => c.json({ url: GATEWAY_API_URL }));

  return app;
};

export const gatewayCaRoutes = () => {
  const app = new Hono();

  app.get("/ca", (c) => {
    const pem = loadCaCertificate();

    if (!pem) {
      return c.json(
        {
          error:
            "CA certificate not available. Start the gateway first to generate it.",
        },
        503,
      );
    }

    return c.body(pem, 200, {
      "content-type": "application/x-pem-file",
      "content-disposition": 'attachment; filename="onecli-gateway-ca.pem"',
    });
  });

  return app;
};

/**
 * `POST /v1/gateway/client-cert` — enroll (or renew) a host for gateway
 * mTLS: mint a short-lived client certificate from a CSR the caller already
 * holds the matching private key for. The private key never crosses this
 * boundary in either direction — only the CSR (proof of possession) goes out
 * to the gateway, and only the signed cert chain comes back (see
 * `clientCertEnrollSchema`'s `.strict()` and `MintClientCertResult`, neither
 * of which has a key field).
 *
 * Identity model: `ClientHost` is per-HOST, not per-call. First call omits
 * `hostId` and gets back a freshly minted one (`identity`/`hostId` in the
 * response); a relay's certificate renewal — re-calling this SAME endpoint
 * before/after its short-lived cert expires — passes that `hostId` back so
 * `ensureClientHost` re-mints against the SAME row/identity instead of
 * accumulating a new one per renewal. `ensureClientHost` scopes that lookup
 * to `projectId` (never trusts `hostId` alone) — see its doc comment for the
 * IDOR guard this is load-bearing for.
 *
 * Auth is the same session-or-API-key `authMiddleware` every other
 * project-scoped route here uses — this is NOT the internal
 * gateway<->Node boundary (`GATEWAY_INTERNAL_SECRET`/`X-Gateway-Secret`),
 * which only `mintClientCert` (via `gateway-client-cert.ts`) speaks, one
 * layer down.
 *
 * TODO(phase-followup): rate-limit this route. It's authenticated (session
 * or API key), but nothing yet caps how often a caller can re-mint — out of
 * scope for this change.
 */
export const clientCertRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  app.post("/client-cert", async (c) => {
    const auth = c.get("auth");
    const projectId = requireProjectId(auth);

    const body = await c.req.json().catch(() => null);
    const parsed = clientCertEnrollSchema.safeParse(body);
    if (!parsed.success) {
      throw new ServiceError(
        "BAD_REQUEST",
        parsed.error.issues[0]?.message ?? "Invalid request body",
      );
    }

    const { id: hostId, spiffeUri } = await ensureClientHost(
      projectId,
      auth.organizationId,
      parsed.data.label,
      parsed.data.hostId,
    );

    const minted = await withAudit(
      () =>
        mintClientCert({
          hostId,
          spiffeUri,
          csrPem: parsed.data.csrPem,
        }),
      (result) => ({
        projectId,
        organizationId: auth.organizationId,
        userId: auth.userId,
        userEmail: auth.userEmail,
        action: AUDIT_ACTIONS.ISSUE,
        service: AUDIT_SERVICES.CLIENT_CERT,
        // Resource identifiers only — never certPem/caPem (chain material)
        // and there is no key to leak in the first place (see the schema
        // and `MintClientCertResult` doc comments above).
        metadata: {
          hostId,
          spiffeUri,
          serial: result.serial,
          notAfter: result.notAfter,
        },
      }),
    );

    await stampClientHostIssued(hostId, minted.serial);

    return c.json({
      identity: spiffeUri,
      hostId,
      certPem: minted.certPem,
      caPem: minted.caPem,
      serial: minted.serial,
      notAfter: minted.notAfter,
    });
  });

  return app;
};
