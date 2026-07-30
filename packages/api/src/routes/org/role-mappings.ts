import { Hono } from "hono";
import type { Context } from "hono";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { ServiceError } from "../../services/errors";
import { parse } from "./parse";
import {
  createOrgRoleMapping,
  deleteOrgRoleMapping,
  listOrgRoleMappings,
  previewOrgRoleMapping,
  reorderOrgRoleMappings,
  updateOrgRoleMapping,
} from "../../services/org-role-mapping-service";
import {
  createRoleMappingSchema,
  previewRoleMappingSchema,
  reorderRoleMappingsSchema,
  updateRoleMappingSchema,
} from "../../validations/org";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../../services/audit-service";

/**
 * `/v1/org/role-mappings` — group → org-role mappings.
 *
 * Same guard stack as `/v1/org/groups`, for the same reasons:
 *
 * `requireProject: false`: these are ORG-scoped routes, so a caller with no
 * project context (an org API key without `X-Project-Id`) must still get
 * through. `role: "admin"` makes the whole router admin-only — a plain member
 * gets a deterministic 403, which is exactly what the web client expects
 * (directory queries are not retried on 403).
 *
 * `role` alone is SCOPE-BLIND, so it is not sufficient on its own: a
 * project-scoped key (the credential an agent carries) resolves to its owning
 * user, and if that user happens to be an org admin the role check passes.
 * Here that is at its sharpest — a leaked agent key would be able to rewrite
 * WHO IS AN ORG ADMIN, minting the very authority the guard exists to
 * protect. Org-wide authority requires an org-wide credential, so
 * project-scoped callers are rejected outright.
 */
export const orgRoleMappingRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", auth({ requireProject: false, role: "admin" }));
  app.use("*", async (c, next) => {
    if (c.get("auth").scope === "project") {
      throw new ServiceError(
        "FORBIDDEN",
        "Organization management requires an organization-scoped credential.",
      );
    }
    return next();
  });

  // `organizationId` in every audit params below is deliberate: besides
  // scoping the audit row it flushes the gateway's org cache
  // (invalidateGatewayCacheForOrg). A mapping write can change a member's org
  // role, which is exactly what authorization reads — a missed flush becomes a
  // stale authorization decision. The MEMBER audit rows the apply writes
  // deliberately do NOT flush again; this one flush covers the request.
  const auditBase = (c: Context<ApiEnv>) => ({
    organizationId: c.get("auth").organizationId,
    userId: c.get("auth").userId,
    userEmail: c.get("auth").userEmail,
    service: AUDIT_SERVICES.ROLE_MAPPING,
    source: AUDIT_SOURCE.API,
  });

  // GET /org/role-mappings — the WHOLE ordered set as a BARE ARRAY (not a
  // DirectoryPage): `groupId` is unique so the set is bounded by group count,
  // the client types it as `RoleMappingRow[]`, and resolution needs all of it.
  app.get("/", async (c) => {
    const auth = c.get("auth");
    return c.json(await listOrgRoleMappings(auth.organizationId));
  });

  // Literal paths are registered BEFORE any parameterized path of the same
  // method (`/preview` before `/`, `/order` ahead of a future `PUT /:id`).
  // Nothing collides by method today; keeping the order is the convention
  // that stops the first such addition from being silently shadowed.

  // POST /org/role-mappings/preview — dry run. Deliberately NOT wrapped in
  // withAudit: it writes nothing, so auditing it would both log a phantom
  // change and wrongly flush the gateway org cache.
  app.post("/preview", async (c) => {
    const auth = c.get("auth");
    const body = await c.req.json().catch(() => null);
    const input = parse(previewRoleMappingSchema, body);
    return c.json(
      await previewOrgRoleMapping(auth.organizationId, auth.userId, input),
    );
  });

  // PUT /org/role-mappings/order — reassign priorities from the FULL ordered
  // id set. Returns the new order as a JSON body: the client's apiPut ALWAYS
  // parses, so a 204 here would throw in the browser.
  app.put("/order", async (c) => {
    const auth = c.get("auth");
    const body = await c.req.json().catch(() => null);
    const input = parse(reorderRoleMappingsSchema, body);

    const result = await withAudit(
      () =>
        reorderOrgRoleMappings(
          auth.organizationId,
          auth.userId,
          input.orderedIds,
        ),
      (r) => ({
        ...auditBase(c),
        action: AUDIT_ACTIONS.UPDATE,
        // Counts only, never id arrays — audit metadata must stay bounded.
        metadata: {
          change: "order",
          count: r.mappings.length,
          rolesChanged: r.rolesChanged,
        },
      }),
    );
    return c.json(result.mappings);
  });

  // POST /org/role-mappings — create (at most one per group: 409 otherwise).
  app.post("/", async (c) => {
    const auth = c.get("auth");
    const body = await c.req.json().catch(() => null);
    const input = parse(createRoleMappingSchema, body);

    const result = await withAudit(
      () => createOrgRoleMapping(auth.organizationId, auth.userId, input),
      (r) => ({
        ...auditBase(c),
        action: AUDIT_ACTIONS.CREATE,
        metadata: {
          mappingId: r.mapping.id,
          groupId: r.mapping.groupId,
          groupName: r.mapping.groupName,
          role: r.mapping.role,
          priority: r.mapping.priority,
          rolesChanged: r.rolesChanged,
        },
      }),
    );
    return c.json(result.mapping);
  });

  // PATCH /org/role-mappings/:id — change the role and/or the priority.
  app.patch("/:id", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const input = parse(updateRoleMappingSchema, body);

    const result = await withAudit(
      () => updateOrgRoleMapping(auth.organizationId, auth.userId, id, input),
      (r) => ({
        ...auditBase(c),
        action: AUDIT_ACTIONS.UPDATE,
        metadata: {
          mappingId: r.mapping.id,
          groupId: r.mapping.groupId,
          change: input.priority !== undefined ? "role+priority" : "role",
          role: r.mapping.role,
          priority: r.mapping.priority,
          rolesChanged: r.rolesChanged,
        },
      }),
    );
    return c.json(result.mapping);
  });

  // DELETE /org/role-mappings/:id — the response carries a JSON body like
  // every other route here (apiDelete discards it; the error path parses).
  app.delete("/:id", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");

    const result = await withAudit(
      () => deleteOrgRoleMapping(auth.organizationId, auth.userId, id),
      (r) => ({
        ...auditBase(c),
        action: AUDIT_ACTIONS.DELETE,
        metadata: {
          mappingId: r.id,
          groupId: r.groupId,
          role: r.role,
          rolesChanged: r.rolesChanged,
        },
      }),
    );
    return c.json(result);
  });

  return app;
};
