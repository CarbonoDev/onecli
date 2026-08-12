import type { Hono, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { ApiEnv } from "../types";
import type { AuthContext } from "../providers";
import type { ResourceScope } from "../services/resource-scope";
import { isOrgScope } from "../services/resource-scope";
import { getApp } from "../apps/registry";
import { getOrgAppConfig } from "../providers";
import {
  invalidateGatewayCache,
  invalidateGatewayCacheForOrg,
} from "../lib/gateway-invalidate";
import {
  getAppConfig,
  upsertAppConfig,
  deleteAppConfig,
  toggleAppConfigEnabled,
  listConfiguredProviders,
  countAppConfigDependents,
} from "../services/app-config-service";
import { parseConfigBody } from "../validations/app-config";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../services/audit-service";
import {
  getBlocklistState,
  toggleBlocklistRule,
  activateBlocklistHost,
  removeBlocklistRule,
} from "../services/app-blocklist-service";

// ── Unified app config + blocklist routes ──────────────────────────────────
// Mounted at /v1/apps/* (project) and /v1/org/apps/* (org). One set of
// handlers, an injected scope — the `registerPolicyRoutes` pattern. The two
// mountings differ only in WHICH scope they read/write and in their auth stack.

const toggleSchema = z.object({ enabled: z.boolean() });

const passthrough = createMiddleware<ApiEnv>(async (_c, next) => next());

export interface AppConfigRouteScope {
  /**
   * Per-route auth guard. `appRoutes()` has no router-wide guard — its routes
   * deliberately differ (`/env-defaults` and the permission catalogs run with
   * `requireProject: false`) — so the PROJECT mounting passes `authMiddleware`
   * and each handler carries it, exactly as before the extraction. The ORG
   * router's `use("*")` stack already covers every path beneath its mount, so
   * it passes nothing; a second guard there would re-authenticate.
   */
  guard?: MiddlewareHandler<ApiEnv>;
  /**
   * The scope this router OWNS — where configs live and where blocklist writes
   * land. Exactly ONE key: `appConfigKey` and `scopeCreate` both need to
   * resolve a single scope.
   */
  resolveScope: (auth: AuthContext) => ResourceScope;
  /**
   * Reads that also surface INHERITED org rows. Only the blocklist panel does
   * this: an org-level block applies to every project under it and renders
   * locked there. The PROJECT router passes both keys; the ORG router passes
   * `organizationId` ONLY — there is nothing above it to inherit from.
   */
  readScope: (auth: AuthContext) => ResourceScope;
  /**
   * The audit — and therefore gateway cache-flush — key. `withAudit` keys
   * `invalidateGatewayCacheForOrg` off `organizationId`, so a missed flush is
   * an org config that keeps minting connections after it was removed.
   */
  auditScope: (auth: AuthContext) => {
    projectId?: string;
    organizationId?: string;
  };
}

/** Registers the config + blocklist handlers on a router whose auth middleware is already set. */
export const registerAppConfigRoutes = (
  app: Hono<ApiEnv>,
  cfg: AppConfigRouteScope,
) => {
  const guard = cfg.guard ?? passthrough;

  const auditBase = (auth: AuthContext) => ({
    ...cfg.auditScope(auth),
    userId: auth.userId,
    userEmail: auth.userEmail,
    service: AUDIT_SERVICES.APP_CONFIG,
    source: AUDIT_SOURCE.API,
  });

  // Blocklist writes are policy rules, not audited resources — they flush the
  // gateway directly. The project surface forwards the caller's own request (as
  // it always has); at org scope there is no single project to forward for, and
  // the change affects every project in the org, so every project key is flushed.
  const flushBlocklist = (request: Request, auth: AuthContext) => {
    if (isOrgScope(cfg.resolveScope(auth))) {
      invalidateGatewayCacheForOrg(auth.organizationId);
    } else {
      invalidateGatewayCache(request);
    }
  };

  // ── GET /configured ── providers with an enabled app config ────────────
  // Registered before GET /:provider so the static path isn't swallowed by
  // the param route.
  app.get("/configured", guard, async (c) => {
    const auth = c.get("auth");
    const scope = cfg.resolveScope(auth);
    // EE (orgAppConfig seam): org-level configs count as configured for every
    // project in the org. OSS: no seam — project rows only, as before. At ORG
    // scope the seam is skipped: this IS the org tier, and `listConfiguredProviders`
    // already returns exactly its rows.
    const [providers, orgConfigs] = await Promise.all([
      listConfiguredProviders(scope),
      isOrgScope(scope)
        ? undefined
        : getOrgAppConfig()?.listEnabledConfigs(auth.organizationId),
    ]);
    if (!orgConfigs) return c.json(providers);
    return c.json([...new Set([...providers, ...Object.keys(orgConfigs)])]);
  });

  // ── GET /:provider/config ── get app config ────────────────────────────
  app.get("/:provider/config", guard, async (c) => {
    const auth = c.get("auth");
    const scope = cfg.resolveScope(auth);
    const provider = c.req.param("provider")!;
    const config = await getAppConfig(scope, provider);

    if (isOrgScope(scope)) {
      // The org tier itself — nothing above it to inherit from, so no seam
      // fallback here. `dependents` is the blast radius of removing or
      // replacing this config: its own org connections PLUS every project
      // connection it minted, which is what the confirm dialog warns about.
      const dependents = await countAppConfigDependents(scope, provider);
      return c.json({
        ...(config ?? { hasCredentials: false, enabled: false }),
        dependents,
      });
    }

    if (config?.enabled) return c.json(config);

    // EE (orgAppConfig seam): no enabled project row — report the org-level
    // config as configured, marked `source: "organization"` so the project
    // config form knows there is no project row to edit. Org settings are
    // deliberately not exposed on the project surface.
    const orgConfig = await getOrgAppConfig()?.getEnabledConfig(
      auth.organizationId,
      provider,
    );
    if (orgConfig) {
      return c.json({
        hasCredentials: orgConfig.hasCredentials,
        enabled: true,
        source: "organization",
      });
    }

    return c.json(config ?? { hasCredentials: false, enabled: false });
  });

  // ── POST /:provider/config ── upsert app config ────────────────────────
  app.post("/:provider/config", guard, async (c) => {
    const auth = c.get("auth");
    const provider = c.req.param("provider")!;

    const appDef = getApp(provider);
    if (!appDef?.configurable) {
      return c.json(
        { error: `Provider "${provider}" does not support app configuration` },
        400,
      );
    }

    const body = await c.req.json().catch(() => null);
    const values = parseConfigBody(body, appDef.configurable.fields);
    if (!values) {
      return c.json({ error: "Invalid request body" }, 400);
    }

    await withAudit(
      () =>
        upsertAppConfig(
          cfg.resolveScope(auth),
          provider,
          values,
          appDef.configurable!.fields,
        ),
      () => ({
        ...auditBase(auth),
        action: AUDIT_ACTIONS.UPDATE,
        metadata: { provider },
      }),
    );

    return c.json({ success: true }, 201);
  });

  // ── DELETE /:provider/config ── delete app config ──────────────────────
  app.delete("/:provider/config", guard, async (c) => {
    const auth = c.get("auth");
    const provider = c.req.param("provider")!;
    await withAudit(
      () => deleteAppConfig(cfg.resolveScope(auth), provider),
      () => ({
        ...auditBase(auth),
        action: AUDIT_ACTIONS.DELETE,
        metadata: { provider },
      }),
    );
    return c.body(null, 204);
  });

  // ── PATCH /:provider/config/toggle ── enable/disable app config ────────
  app.patch("/:provider/config/toggle", guard, async (c) => {
    const auth = c.get("auth");
    const provider = c.req.param("provider")!;
    const body = await c.req.json().catch(() => null);
    const parsed = toggleSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }
    await withAudit(
      () =>
        toggleAppConfigEnabled(
          cfg.resolveScope(auth),
          provider,
          parsed.data.enabled,
        ),
      () => ({
        ...auditBase(auth),
        action: AUDIT_ACTIONS.UPDATE,
        metadata: { provider, enabled: parsed.data.enabled },
      }),
    );
    return c.json({ success: true });
  });

  // ── GET /:provider/blocklist ── list blocklist state ───────────────────
  app.get("/:provider/blocklist", guard, async (c) => {
    const auth = c.get("auth");
    const provider = c.req.param("provider")!;
    const appDef = getApp(provider);
    if (!appDef) return c.json({ error: "Unknown provider" }, 404);

    const states = await getBlocklistState(
      cfg.readScope(auth),
      provider,
      appDef.blocklist ?? [],
    );
    return c.json(states);
  });

  // ── POST /:provider/blocklist ── activate one of the app's hosts ───────
  app.post("/:provider/blocklist", guard, async (c) => {
    const auth = c.get("auth");
    const provider = c.req.param("provider")!;
    const appDef = getApp(provider);
    if (!appDef) return c.json({ error: "Unknown provider" }, 404);

    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "Invalid request body" }, 400);

    // Blocking an arbitrary host is a policy rule (POST /v1/policy/rules) now;
    // this surface only toggles the hosts the app itself declares.
    if (!body.hostId) {
      return c.json({ error: "Provide { hostId }" }, 400);
    }
    const result = await activateBlocklistHost(
      cfg.resolveScope(auth),
      provider,
      body.hostId,
      appDef.blocklist ?? [],
    );

    flushBlocklist(c.req.raw, auth);
    return c.json(result, 201);
  });

  // ── PATCH /:provider/blocklist/:ruleId ── toggle enabled ───────────────
  app.patch("/:provider/blocklist/:ruleId", guard, async (c) => {
    const auth = c.get("auth");
    const ruleId = c.req.param("ruleId")!;

    const body = await c.req.json().catch(() => null);
    if (body?.enabled === undefined)
      return c.json({ error: "enabled is required" }, 400);

    await toggleBlocklistRule(cfg.resolveScope(auth), ruleId, body.enabled);
    flushBlocklist(c.req.raw, auth);
    return c.json({ success: true });
  });

  // ── DELETE /:provider/blocklist/:ruleId ── remove blocklist rule ───────
  app.delete("/:provider/blocklist/:ruleId", guard, async (c) => {
    const auth = c.get("auth");
    const ruleId = c.req.param("ruleId")!;

    await removeBlocklistRule(cfg.resolveScope(auth), ruleId);
    flushBlocklist(c.req.raw, auth);
    return c.body(null, 204);
  });
};
