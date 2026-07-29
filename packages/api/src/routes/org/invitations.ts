import { Hono } from "hono";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { ServiceError } from "../../services/errors";
import { parse } from "./parse";
import {
  createOrgInvitation,
  listOrgInvitations,
  revokeOrgInvitation,
} from "../../services/org-invitation-service";
import {
  createInvitationSchema,
  invitationListQuerySchema,
} from "../../validations/org";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../../services/audit-service";

/**
 * `/v1/org/invitations` — link-based invitations to the organization.
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
 * leaked agent key would then be able to mint invitation links into the org.
 * Org-wide authority requires an org-wide credential, so project-scoped
 * callers are rejected outright.
 *
 * There is deliberately NO accept route here (D-G): accepting runs through a
 * Server Action, because a brand-new invitee has a session but no DB user row
 * and the standard auth middleware cannot authenticate them.
 */
export const orgInvitationRoutes = () => {
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

  // GET /org/invitations — cursor-paged, optionally filtered by status / email.
  app.get("/", async (c) => {
    const auth = c.get("auth");
    const query = parse(invitationListQuerySchema, c.req.query());
    return c.json(await listOrgInvitations(auth.organizationId, query));
  });

  // POST /org/invitations — mint (or re-issue) an invitation link.
  app.post("/", async (c) => {
    const auth = c.get("auth");
    const body = await c.req.json().catch(() => null);
    const input = parse(createInvitationSchema, body);

    // `organizationId` in the audit params is deliberate: besides scoping the
    // audit row it flushes the gateway's org cache. The metadata NEVER carries
    // the token — an audit row must not be a second channel for the secret.
    const invitation = await withAudit(
      () =>
        createOrgInvitation(
          auth.organizationId,
          auth.userId,
          auth.userEmail,
          input,
        ),
      (inv) => ({
        organizationId: auth.organizationId,
        userId: auth.userId,
        userEmail: auth.userEmail,
        action: AUDIT_ACTIONS.CREATE,
        service: AUDIT_SERVICES.INVITATION,
        source: AUDIT_SOURCE.API,
        metadata: { invitationId: inv.id, email: inv.email, role: inv.role },
      }),
    );
    return c.json(invitation);
  });

  // DELETE /org/invitations/:id — revoke a pending invitation.
  app.delete("/:id", async (c) => {
    const auth = c.get("auth");
    const invitationId = c.req.param("id");

    const revoked = await withAudit(
      () => revokeOrgInvitation(auth.organizationId, invitationId),
      (r) => ({
        organizationId: auth.organizationId,
        userId: auth.userId,
        userEmail: auth.userEmail,
        action: AUDIT_ACTIONS.DELETE,
        service: AUDIT_SERVICES.INVITATION,
        source: AUDIT_SOURCE.API,
        metadata: { invitationId: r.id, email: r.email },
      }),
    );
    return c.json(revoked);
  });

  return app;
};
