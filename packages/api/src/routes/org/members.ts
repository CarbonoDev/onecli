import { Hono } from "hono";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { ServiceError } from "../../services/errors";
import { parse } from "./parse";
import {
  listOrgMembers,
  updateOrgMemberRole,
  updateOrgMemberStatus,
} from "../../services/org-member-service";
import {
  orgMemberListQuerySchema,
  updateOrgMemberSchema,
} from "../../validations/org";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../../services/audit-service";

/**
 * `/v1/org/members` — the organization's membership directory.
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
 * leaked agent key would then be able to manage org membership. Org-wide
 * authority requires an org-wide credential, so project-scoped callers are
 * rejected outright.
 */
export const orgMemberRoutes = () => {
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

  // GET /org/members — cursor-paged, optionally filtered by status / free text.
  app.get("/", async (c) => {
    const auth = c.get("auth");
    const query = parse(orgMemberListQuerySchema, c.req.query());
    return c.json(await listOrgMembers(auth.organizationId, query));
  });

  // PATCH /org/members/:userId — exactly one of { status } | { role }.
  app.patch("/:userId", async (c) => {
    const auth = c.get("auth");
    const targetUserId = c.req.param("userId");
    const body = await c.req.json().catch(() => null);
    const input = parse(updateOrgMemberSchema, body);

    // `organizationId` in the audit params is deliberate: besides scoping the
    // audit row it flushes the gateway's org cache, which a membership change
    // must invalidate.
    const auditBase = {
      organizationId: auth.organizationId,
      userId: auth.userId,
      userEmail: auth.userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.MEMBER,
      source: AUDIT_SOURCE.API,
    };

    if ("status" in input) {
      const member = await withAudit(
        () =>
          updateOrgMemberStatus(
            auth.organizationId,
            auth.userId,
            targetUserId,
            input.status,
          ),
        (updated) => ({
          ...auditBase,
          metadata: { targetUserId, status: updated.status },
        }),
      );
      return c.json(member);
    }

    const member = await withAudit(
      () =>
        updateOrgMemberRole(
          auth.organizationId,
          auth.userId,
          targetUserId,
          input.role,
        ),
      (updated) => ({
        ...auditBase,
        metadata: { targetUserId, role: updated.role },
      }),
    );
    return c.json(member);
  });

  return app;
};
