import { Hono } from "hono";
import type { Context } from "hono";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { ServiceError } from "../../services/errors";
import { parse } from "./parse";
import {
  addOrgGroupMember,
  createOrgGroup,
  deleteOrgGroup,
  listOrgGroupMembers,
  listOrgGroups,
  removeOrgGroupMember,
  renameOrgGroup,
  setOrgGroupMembers,
} from "../../services/org-group-service";
import {
  createGroupSchema,
  directoryListQuerySchema,
  groupListQuerySchema,
  renameGroupSchema,
  setGroupMembersSchema,
} from "../../validations/org";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../../services/audit-service";

/**
 * `/v1/org/groups` — the organization's human groups.
 *
 * Same guard stack as `/v1/org/members`, for the same reasons:
 *
 * `requireProject: false`: these are ORG-scoped routes, so a caller with no
 * project context (an org API key without `X-Project-Id`) must still get
 * through. `role: "admin"` makes the whole router admin-only — a plain member
 * gets a deterministic 403, which is exactly what the web client expects
 * (directory queries are not retried on 403). Both only work because the OSS
 * edition now registers a `RoleResolver`.
 *
 * `role` alone is SCOPE-BLIND, so it is not sufficient on its own: a
 * project-scoped key (the credential an agent carries) resolves to its owning
 * user, and if that user happens to be an org admin the role check passes. A
 * leaked agent key would then be able to rewrite group membership — the very
 * substrate project access and policy identities hang off. Org-wide authority
 * requires an org-wide credential, so project-scoped callers are rejected
 * outright.
 */
export const orgGroupRoutes = () => {
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
  // (invalidateGatewayCacheForOrg). Group membership is exactly what the
  // gateway's principal resolution reads — a missed flush becomes a stale
  // authorization decision, so EVERY membership write must go through withAudit.
  const auditBase = (c: Context<ApiEnv>) => ({
    organizationId: c.get("auth").organizationId,
    userId: c.get("auth").userId,
    userEmail: c.get("auth").userEmail,
    service: AUDIT_SERVICES.GROUP,
    source: AUDIT_SOURCE.API,
  });

  // GET /org/groups — cursor-paged, optionally filtered by source / free text.
  app.get("/", async (c) => {
    const auth = c.get("auth");
    const query = parse(groupListQuerySchema, c.req.query());
    return c.json(await listOrgGroups(auth.organizationId, query));
  });

  // POST /org/groups — create a manual group.
  app.post("/", async (c) => {
    const auth = c.get("auth");
    const body = await c.req.json().catch(() => null);
    const input = parse(createGroupSchema, body);

    const group = await withAudit(
      () => createOrgGroup(auth.organizationId, input.name),
      (created) => ({
        ...auditBase(c),
        action: AUDIT_ACTIONS.CREATE,
        metadata: { groupId: created.id, name: created.name },
      }),
    );
    return c.json(group);
  });

  // PATCH /org/groups/:groupId — rename.
  app.patch("/:groupId", async (c) => {
    const auth = c.get("auth");
    const groupId = c.req.param("groupId");
    const body = await c.req.json().catch(() => null);
    const input = parse(renameGroupSchema, body);

    const group = await withAudit(
      () => renameOrgGroup(auth.organizationId, groupId, input.name),
      (renamed) => ({
        ...auditBase(c),
        action: AUDIT_ACTIONS.UPDATE,
        metadata: { groupId: renamed.id, change: "name", name: renamed.name },
      }),
    );
    return c.json(group);
  });

  // DELETE /org/groups/:groupId — the response carries the cascade impact
  // (read before the delete) so the UI can report what went with the group.
  app.delete("/:groupId", async (c) => {
    const auth = c.get("auth");
    const groupId = c.req.param("groupId");

    const result = await withAudit(
      () => deleteOrgGroup(auth.organizationId, groupId),
      (deleted) => ({
        ...auditBase(c),
        action: AUDIT_ACTIONS.DELETE,
        // Counts only, never id arrays — audit metadata must stay bounded.
        metadata: {
          groupId: deleted.id,
          name: deleted.name,
          removedMembers: deleted.removedMembers,
          removedProjectBindings: deleted.removedProjectBindings,
        },
      }),
    );
    return c.json(result);
  });

  // GET /org/groups/:groupId/members — cursor-paged member list.
  app.get("/:groupId/members", async (c) => {
    const auth = c.get("auth");
    const groupId = c.req.param("groupId");
    const query = parse(directoryListQuerySchema, c.req.query());
    return c.json(
      await listOrgGroupMembers(auth.organizationId, groupId, query),
    );
  });

  // PUT /org/groups/:groupId/members — bulk replace-set (the dialog's save).
  // Every PUT returns a JSON body: the client's apiPut ALWAYS parses, so a
  // 204 here would throw in the browser.
  app.put("/:groupId/members", async (c) => {
    const auth = c.get("auth");
    const groupId = c.req.param("groupId");
    const body = await c.req.json().catch(() => null);
    const input = parse(setGroupMembersSchema, body);

    const result = await withAudit(
      () =>
        setOrgGroupMembers(
          auth.organizationId,
          auth.userId,
          groupId,
          input.userIds,
        ),
      (delta) => ({
        ...auditBase(c),
        action: AUDIT_ACTIONS.UPDATE,
        metadata: {
          groupId,
          change: "members",
          added: delta.added,
          removed: delta.removed,
        },
      }),
    );
    return c.json(result);
  });

  // PUT /org/groups/:groupId/members/:userId — idempotent single add.
  app.put("/:groupId/members/:userId", async (c) => {
    const auth = c.get("auth");
    const groupId = c.req.param("groupId");
    const userId = c.req.param("userId");

    const result = await withAudit(
      () =>
        addOrgGroupMember(auth.organizationId, auth.userId, groupId, userId),
      (r) => ({
        ...auditBase(c),
        action: AUDIT_ACTIONS.UPDATE,
        metadata: { groupId, change: "members", userId, added: r.added },
      }),
    );
    return c.json(result);
  });

  // DELETE /org/groups/:groupId/members/:userId — idempotent single remove.
  app.delete("/:groupId/members/:userId", async (c) => {
    const auth = c.get("auth");
    const groupId = c.req.param("groupId");
    const userId = c.req.param("userId");

    const result = await withAudit(
      () => removeOrgGroupMember(auth.organizationId, groupId, userId),
      (r) => ({
        ...auditBase(c),
        action: AUDIT_ACTIONS.UPDATE,
        metadata: { groupId, change: "members", userId, removed: r.removed },
      }),
    );
    return c.json(result);
  });

  return app;
};
