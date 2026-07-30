import { Hono } from "hono";
import type { Context } from "hono";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { ServiceError } from "../../services/errors";
import { parse } from "./parse";
import { canAccessProjectAsUser } from "../../middleware/auth/resolve";
import {
  deleteProject,
  getProject,
  renameProject,
  requireManageableProject,
  requireProject,
} from "../../services/project-service";
import {
  listProjectAccess,
  setProjectAccess,
} from "../../services/project-access-service";
import {
  renameProjectSchema,
  setProjectAccessSchema,
} from "../../validations/project";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../../services/audit-service";

/**
 * `/v1/projects/*` — project administration (rename, delete, sharing).
 *
 * Lives under `routes/org/` because that is the OSS-owned, package-exported
 * route folder — the URL is `/v1/projects/...`, NOT `/v1/org/projects`.
 *
 * The guard stack deliberately DIFFERS from `/v1/org/*`:
 *
 * `requireProject: false` — the project is named in the path. Demanding an
 * `X-Project-Id` header would 401 the OSS web (which sends no headers at all)
 * and would introduce a second, conflicting project scope on every request.
 *
 * NO `role: "admin"` — unlike the org directory, this surface is legitimately
 * reachable by a plain member who holds an `owner` binding (13c: the project
 * owner may rename / share / delete). Authorization is therefore PER-RESOURCE,
 * in the service (`requireManageableProject` / `canAccessProjectAsUser`), never
 * in the middleware.
 *
 * The `scope === "project"` fence is kept for exactly the org routers' reason:
 * a project-scoped key is the credential an AGENT carries, and a leaked agent
 * key must never be able to rename, delete or re-share the project it lives in.
 */
export const ossProjectRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", auth({ requireProject: false }));
  app.use("*", async (c, next) => {
    if (c.get("auth").scope === "project") {
      throw new ServiceError(
        "FORBIDDEN",
        "Managing a project requires a session or an organization-scoped credential.",
      );
    }
    return next();
  });

  // `organizationId` on every write is load-bearing, not decoration: besides
  // scoping the audit row it flushes the gateway's org cache
  // (invalidateGatewayCacheForOrg). ProjectAccess IS the `PrincipalSet` the
  // Rust policy engine resolves, so a missed flush is a stale AUTHORIZATION
  // decision for as long as the cache window lasts.
  const auditBase = (c: Context<ApiEnv>) => ({
    organizationId: c.get("auth").organizationId,
    userId: c.get("auth").userId,
    userEmail: c.get("auth").userEmail,
    service: AUDIT_SERVICES.PROJECT,
    source: AUDIT_SOURCE.API,
  });

  /** Read authorization: anyone who may USE the project may read it. Resolve
   * first (404 for unknown/cross-org), then authorize (403). */
  const requireReadableProject = async (
    organizationId: string,
    userId: string,
    projectId: string,
  ) => {
    const project = await requireProject(organizationId, projectId);
    if (
      !(await canAccessProjectAsUser(userId, {
        id: project.id,
        organizationId,
      }))
    ) {
      throw new ServiceError(
        "FORBIDDEN",
        "You do not have access to this project.",
      );
    }
    return project;
  };

  // GET /projects/:projectId — the sharing page's name/slug source. Nothing
  // else in the API exposes a project's name (the session route returns only
  // `projectId`).
  app.get("/:projectId", async (c) => {
    const auth = c.get("auth");
    const projectId = c.req.param("projectId");
    await requireReadableProject(auth.organizationId, auth.userId, projectId);
    return c.json(await getProject(auth.organizationId, projectId));
  });

  // PATCH /projects/:projectId — rename (name only; `slug` is immutable).
  app.patch("/:projectId", async (c) => {
    const auth = c.get("auth");
    const projectId = c.req.param("projectId");
    await requireManageableProject(auth.organizationId, auth.userId, projectId);
    const body = await c.req.json().catch(() => null);
    const input = parse(renameProjectSchema, body);

    const project = await withAudit(
      () => renameProject(auth.organizationId, projectId, input.name),
      (renamed) => ({
        ...auditBase(c),
        projectId,
        action: AUDIT_ACTIONS.UPDATE,
        metadata: { projectId, change: "name", name: renamed.name },
      }),
    );
    return c.json(project);
  });

  // DELETE /projects/:projectId — explicit pinned cascade, three refusals.
  app.delete("/:projectId", async (c) => {
    const auth = c.get("auth");
    const projectId = c.req.param("projectId");
    await requireManageableProject(auth.organizationId, auth.userId, projectId);

    const result = await withAudit(
      () => deleteProject(auth.organizationId, auth.userId, projectId),
      (deleted) => ({
        ...auditBase(c),
        // NO `projectId` here, deliberately: withAudit writes the audit row
        // AFTER the delete resolves, so an audit_logs row pointing at the
        // just-deleted project violates audit_logs_project_id_fkey — and
        // logAuditEvent SWALLOWS its own errors, so the delete would end up
        // completely unaudited. `organizationId` keeps it attributable.
        action: AUDIT_ACTIONS.DELETE,
        // Counts only, never id arrays — audit metadata must stay bounded.
        metadata: { projectId, name: deleted.name, removed: deleted.removed },
      }),
    );

    // No flush here: withAudit's `invalidateGatewayCacheForAccount` cannot work
    // (it looks keys up by projectId, and they are gone) and a by-key flush is
    // impossible once the keys no longer authenticate — so `deleteProject`
    // flushes them itself, before the cascade. `organizationId` on the audit
    // still flushes every SURVIVING project in the org.
    return c.json({
      id: result.id,
      name: result.name,
      removed: result.removed,
    });
  });

  // GET /projects/:projectId/access — the sharing surface's current bindings.
  app.get("/:projectId/access", async (c) => {
    const auth = c.get("auth");
    const projectId = c.req.param("projectId");
    await requireReadableProject(auth.organizationId, auth.userId, projectId);
    return c.json(await listProjectAccess(auth.organizationId, projectId));
  });

  // PUT /projects/:projectId/access — bulk replace-set (the dialog's save).
  // Returns a JSON body: the client's apiPut ALWAYS parses, so a 204 here
  // would throw in the browser.
  app.put("/:projectId/access", async (c) => {
    const auth = c.get("auth");
    const projectId = c.req.param("projectId");
    const { isOrgAdmin } = await requireManageableProject(
      auth.organizationId,
      auth.userId,
      projectId,
    );
    const body = await c.req.json().catch(() => null);
    const input = parse(setProjectAccessSchema, body);

    const result = await withAudit(
      () =>
        setProjectAccess(
          auth.organizationId,
          auth.userId,
          isOrgAdmin,
          projectId,
          input,
        ),
      (delta) => ({
        ...auditBase(c),
        projectId,
        action: AUDIT_ACTIONS.UPDATE,
        metadata: {
          projectId,
          change: "access",
          added: delta.added,
          removed: delta.removed,
          roleChanged: delta.roleChanged,
        },
      }),
    );
    return c.json(result);
  });

  return app;
};
