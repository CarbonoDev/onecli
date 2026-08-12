import { Hono } from "hono";
import type { ApiEnv } from "../types";
import type { AuthContext } from "../providers";
import type { ResourceScope } from "../services/resource-scope";
import { authMiddleware, requireProjectId } from "../middleware/auth";
import { invalidateGatewayCache } from "../lib/gateway-invalidate";
import {
  listSecrets,
  createSecret,
  updateSecret,
  deleteSecret,
} from "../services/secret-service";
import { createSecretSchema, updateSecretSchema } from "../validations/secret";
import { getResourceHooks } from "../providers";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  type AuditParams,
} from "../services/audit-service";

// ── Unified secret routes (/v1/secrets, /v1/org/secrets) ────────────────────
// One set of handlers, an injected scope — the `registerPolicyRoutes` pattern.
// The two routers differ only in WHICH scope they read/write and in their auth
// stack; forking the handlers is exactly what this shape exists to avoid.

export interface SecretRouteScope {
  /**
   * The scope a LIST reads from. The PROJECT router passes BOTH keys on
   * purpose: `scopeWhere` ORs the org's org-scoped rows in, which is how an org
   * secret inherits into every project. The ORG router passes `organizationId`
   * ONLY — see `resolveScope` in `org/policy.ts`.
   */
  readScope: (auth: AuthContext) => ResourceScope;
  /**
   * The scope a write creates in, and the fence an update/delete is checked
   * against. Exactly ONE key: `scopeCreate` rejects a two-key scope outright.
   */
  writeScope: (auth: AuthContext) => ResourceScope;
  /**
   * Set on the ORG mounting only. When present, writes run through `withAudit`
   * with these keys — not decoration: `withAudit` keys
   * `invalidateGatewayCacheForOrg` off `organizationId`, so this is the
   * gateway cache-flush key, and a missed flush is an org secret that keeps
   * injecting for a cache window after it was deleted.
   *
   * Absent on the PROJECT mounting, which keeps its long-standing behavior
   * unchanged: no audit row, and a flush that forwards the caller's own request
   * to the gateway. Auditing the project surface is a separate change.
   */
  auditScope?: (auth: AuthContext) => {
    projectId?: string;
    organizationId?: string;
  };
}

/** Registers the secret handlers on a router whose auth middleware is already set. */
export const registerSecretRoutes = (
  app: Hono<ApiEnv>,
  cfg: SecretRouteScope,
) => {
  const write = async <T>(
    request: Request,
    auth: AuthContext,
    run: () => Promise<T>,
    audit: (result: T) => Pick<AuditParams, "action" | "metadata">,
  ): Promise<T> => {
    const auditScope = cfg.auditScope?.(auth);
    if (!auditScope) {
      const result = await run();
      invalidateGatewayCache(request);
      return result;
    }
    return withAudit(run, (result) => ({
      ...auditScope,
      userId: auth.userId,
      userEmail: auth.userEmail,
      service: AUDIT_SERVICES.SECRET,
      source: AUDIT_SOURCE.API,
      ...audit(result),
    }));
  };

  // GET /secrets
  app.get("/", async (c) => {
    const auth = c.get("auth");
    const secrets = await listSecrets(cfg.readScope(auth));
    return c.json(secrets);
  });

  // POST /secrets
  app.post("/", async (c) => {
    const auth = c.get("auth");
    const body = await c.req.json().catch(() => null);
    const parsed = createSecretSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    await getResourceHooks().beforeCreateSecret(auth.organizationId);

    // `createSecret` rejects a 1Password-backed value at org scope with a
    // written-out reason (its op:// ref resolves through a per-project
    // connection); that ServiceError surfaces as the 400 the form renders.
    const secret = await write(
      c.req.raw,
      auth,
      () => createSecret(cfg.writeScope(auth), parsed.data),
      (created) => ({
        action: AUDIT_ACTIONS.CREATE,
        metadata: {
          secretId: created.id,
          name: created.name,
          type: created.type,
        },
      }),
    );
    return c.json(secret, 201);
  });

  // PATCH /secrets/:secretId
  app.patch("/:secretId", async (c) => {
    const auth = c.get("auth");
    const secretId = c.req.param("secretId");
    const body = await c.req.json().catch(() => null);
    const parsed = updateSecretSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    await write(
      c.req.raw,
      auth,
      () => updateSecret(cfg.writeScope(auth), secretId, parsed.data),
      () => ({ action: AUDIT_ACTIONS.UPDATE, metadata: { secretId } }),
    );
    return c.json({ success: true });
  });

  // DELETE /secrets/:secretId
  app.delete("/:secretId", async (c) => {
    const auth = c.get("auth");
    const secretId = c.req.param("secretId");
    await write(
      c.req.raw,
      auth,
      () => deleteSecret(cfg.writeScope(auth), secretId),
      () => ({ action: AUDIT_ACTIONS.DELETE, metadata: { secretId } }),
    );
    return c.body(null, 204);
  });
};

export const secretRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  registerSecretRoutes(app, {
    readScope: (auth) => ({
      projectId: requireProjectId(auth),
      organizationId: auth.organizationId,
    }),
    writeScope: (auth) => ({ projectId: requireProjectId(auth) }),
  });

  return app;
};
