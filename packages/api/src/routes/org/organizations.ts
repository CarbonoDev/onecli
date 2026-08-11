import { Hono } from "hono";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { ServiceError } from "../../services/errors";
import { parse } from "./parse";
import {
  listUserOrganizations,
  renameOrganization,
  requireOrgAdmin,
} from "../../services/organization-service";
import { renameOrganizationSchema } from "../../validations/org";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../../services/audit-service";

/**
 * `/v1/organizations` — the org switcher's source, plus the org rename.
 *
 * Guard stack mirrors `/v1/projects`: `requireProject: false` (this is not a
 * project-scoped surface), no `role` filter (every active member may see the
 * orgs they belong to, not just admins), and the same `scope === "project"`
 * fence — a project-scoped key is the credential an AGENT carries, and a leaked
 * agent key must not be able to enumerate its owner's other organizations, nor
 * rename the one it belongs to.
 *
 * Because the router-wide guard cannot carry `role: "admin"` (GET is
 * member-visible), the write authorizes per-resource via `requireOrgAdmin`.
 */
export const ossOrganizationRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", auth({ requireProject: false }));
  app.use("*", async (c, next) => {
    if (c.get("auth").scope === "project") {
      throw new ServiceError(
        "FORBIDDEN",
        "Listing organizations requires a session or an organization-scoped credential.",
      );
    }
    return next();
  });

  // GET /organizations — as with GET /projects there is no id to resolve, so
  // there is nothing to 404 and nothing to 403: the service IS the
  // authorization, returning only the caller's active memberships.
  app.get("/", async (c) => {
    const auth = c.get("auth");
    return c.json(await listUserOrganizations(auth.userId));
  });

  // PATCH /organizations/:organizationId — rename (name only; `slug` is
  // immutable). Admin-only, and fenced to the caller's OWN organization: the
  // credential already resolves to exactly one org, so any other id is not a
  // 403 (which would confirm the org exists) but a 404.
  app.patch("/:organizationId", async (c) => {
    const auth = c.get("auth");
    if (c.req.param("organizationId") !== auth.organizationId) {
      throw new ServiceError("NOT_FOUND", "Organization not found.");
    }
    await requireOrgAdmin(auth.userId, auth.organizationId);

    const body = await c.req.json().catch(() => null);
    const input = parse(renameOrganizationSchema, body);

    const organization = await withAudit(
      () => renameOrganization(auth.organizationId, input.name),
      (renamed) => ({
        organizationId: auth.organizationId,
        userId: auth.userId,
        userEmail: auth.userEmail,
        service: AUDIT_SERVICES.ORGANIZATION,
        source: AUDIT_SOURCE.API,
        action: AUDIT_ACTIONS.UPDATE,
        metadata: { change: "name", name: renamed.name },
      }),
    );
    return c.json(organization);
  });

  return app;
};
