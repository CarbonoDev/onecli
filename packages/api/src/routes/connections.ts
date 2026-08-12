import { Hono } from "hono";
import { db } from "@onecli/db";
import type { ApiEnv } from "../types";
import type { ResourceScope } from "../services/resource-scope";
import { authMiddleware, requireProjectId } from "../middleware/auth";
import {
  listConnections,
  listConnectionsByProvider,
  deleteConnection,
  updateConnectionLabel,
} from "../services/connection-service";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../services/audit-service";
import { removeAllBlocklistRules } from "../services/app-blocklist-service";
import { getApp } from "../apps/registry";
import {
  invalidateGatewayCacheForAccount,
  invalidateGatewayCacheForOrg,
} from "../lib/gateway-invalidate";

type Auth = ApiEnv["Variables"]["auth"];

/**
 * The rows a surface may manage. The PROJECT surface carries both keys — a
 * project-scoped row in the caller's project, or an org-scoped row in the
 * caller's organization (project members may manage org rows through the
 * project surface — longstanding behavior). The ORG surface carries
 * `organizationId` ONLY: it has no project context to require, and project
 * rows must not be reachable there.
 */
export interface ConnectionOwnership {
  projectId?: string;
  organizationId?: string;
}

/** The PROJECT surface's ownership set, shared with the legacy /v1/apps aliases. */
export const projectConnectionOwnership = (
  auth: Auth,
): ConnectionOwnership => ({
  projectId: requireProjectId(auth),
  organizationId: auth.organizationId,
});

const findOwnedConnection = (own: ConnectionOwnership, connectionId: string) =>
  db.appConnection.findFirst({
    where: {
      id: connectionId,
      OR: [
        ...(own.projectId ? [{ projectId: own.projectId }] : []),
        ...(own.organizationId ? [{ organizationId: own.organizationId }] : []),
      ],
    },
    select: { scope: true, provider: true },
  });

/**
 * Disconnect flow shared by /v1/connections/:id and its legacy alias
 * /v1/apps/connections/:id — audit (auto-flushes), then blocklist cleanup
 * with a re-flush when the provider's last connection went away.
 * Returns false when the connection isn't owned by the caller (404).
 */
export const disconnectOwnedConnection = async (
  auth: Auth,
  connectionId: string,
  own: ConnectionOwnership = projectConnectionOwnership(auth),
): Promise<boolean> => {
  const connection = await findOwnedConnection(own, connectionId);
  if (!connection) return false;

  const isOrg = connection.scope === "organization";
  const scope = isOrg
    ? { organizationId: auth.organizationId }
    : { projectId: requireProjectId(auth) };
  await withAudit(
    () => deleteConnection(scope, connectionId),
    () => ({
      ...(isOrg
        ? { organizationId: auth.organizationId }
        : { projectId: requireProjectId(auth) }),
      userId: auth.userId,
      userEmail: auth.userEmail,
      action: AUDIT_ACTIONS.DISCONNECT,
      service: AUDIT_SERVICES.APP_CONNECTION,
      source: AUDIT_SOURCE.API,
      metadata: isOrg
        ? { connectionId, scope: "organization" }
        : { connectionId },
    }),
  );

  const remaining = await listConnectionsByProvider(scope, connection.provider);
  if (remaining.length === 0) {
    await removeAllBlocklistRules(
      scope,
      connection.provider,
      getApp(connection.provider)?.blocklist ?? [],
    );
    // withAudit's flush ran before the blocklist cleanup — flush once more
    // so removed deny-rules can't linger in the gateway cache.
    if (isOrg) invalidateGatewayCacheForOrg(auth.organizationId);
    else invalidateGatewayCacheForAccount(requireProjectId(auth));
  }

  return true;
};

/**
 * Rename flow shared by /v1/connections/:id and its legacy alias.
 * Returns null when the connection isn't owned by the caller (404).
 */
export const renameOwnedConnection = async (
  auth: Auth,
  connectionId: string,
  label: string,
  own: ConnectionOwnership = projectConnectionOwnership(auth),
) => {
  const connection = await findOwnedConnection(own, connectionId);
  if (!connection) return null;

  const isOrg = connection.scope === "organization";
  const scope = isOrg
    ? { organizationId: auth.organizationId }
    : { projectId: requireProjectId(auth) };

  return withAudit(
    () => updateConnectionLabel(scope, connectionId, label),
    () => ({
      ...(isOrg
        ? { organizationId: auth.organizationId }
        : { projectId: requireProjectId(auth) }),
      userId: auth.userId,
      userEmail: auth.userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.APP_CONNECTION,
      source: AUDIT_SOURCE.API,
      metadata: isOrg
        ? { connectionId, scope: "organization" }
        : { connectionId },
    }),
  );
};

// ── Unified connection routes (/v1/connections, /v1/org/connections) ───────
// One set of handlers, an injected scope — the `registerPolicyRoutes` pattern.

export interface ConnectionRouteScope {
  /**
   * The scope a LIST reads from. The PROJECT router passes BOTH keys on
   * purpose: `scopeWhere` ORs the org's org-scoped rows in, which is how an org
   * connection inherits into every project. The ORG router passes
   * `organizationId` ONLY.
   */
  readScope: (auth: Auth) => ResourceScope;
  /** The rows a rename/disconnect on this surface may reach. */
  ownership: (auth: Auth) => ConnectionOwnership;
}

/** Registers the connection handlers on a router whose auth middleware is already set. */
export const registerConnectionRoutes = (
  app: Hono<ApiEnv>,
  cfg: ConnectionRouteScope,
) => {
  // ── GET /connections?provider= ── list connections ─────────────────────
  app.get("/", async (c) => {
    const auth = c.get("auth");
    const provider = c.req.query("provider");
    const scope = cfg.readScope(auth);
    const connections = provider
      ? await listConnectionsByProvider(scope, provider)
      : await listConnections(scope);
    return c.json(connections);
  });

  // ── PATCH /connections/:connectionId ── rename ─────────────────────────
  app.patch("/:connectionId", async (c) => {
    const auth = c.get("auth");
    const connectionId = c.req.param("connectionId");

    const body = (await c.req.json().catch(() => null)) as {
      label?: string;
    } | null;
    const label = body?.label?.trim();
    if (!label) {
      return c.json({ error: "Label is required" }, 400);
    }

    const updated = await renameOwnedConnection(
      auth,
      connectionId,
      label,
      cfg.ownership(auth),
    );
    if (!updated) {
      return c.json({ error: "Connection not found" }, 404);
    }
    return c.json(updated);
  });

  // ── DELETE /connections/:connectionId ── disconnect ────────────────────
  app.delete("/:connectionId", async (c) => {
    const auth = c.get("auth");
    const connectionId = c.req.param("connectionId");
    const deleted = await disconnectOwnedConnection(
      auth,
      connectionId,
      cfg.ownership(auth),
    );
    if (!deleted) {
      return c.json({ error: "Connection not found" }, 404);
    }
    return c.body(null, 204);
  });
};

// Connections as a top-level resource. The legacy /v1/apps/connections* paths
// remain as aliases (routes/apps.ts) sharing the cores above; unlike them,
// this surface filters via ?provider= (never the path — the single-segment
// GET slot stays reserved for get-by-id) and returns bare arrays.
export const connectionRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  registerConnectionRoutes(app, {
    readScope: (auth) => ({
      projectId: requireProjectId(auth),
      organizationId: auth.organizationId,
    }),
    ownership: projectConnectionOwnership,
  });

  return app;
};
