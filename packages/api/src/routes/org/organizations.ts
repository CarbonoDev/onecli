import { Hono } from "hono";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { ServiceError } from "../../services/errors";
import { parse } from "./parse";
import {
  createOrganization,
  listUserOrganizations,
  renameOrganization,
  requireOrgAdmin,
} from "../../services/organization-service";
import {
  createOrganizationSchema,
  renameOrganizationSchema,
} from "../../validations/org";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../../services/audit-service";

/**
 * `/v1/organizations` — the org switcher's source, plus create and rename.
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
        "Reading or managing organizations requires a session or an organization-scoped credential.",
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

  // POST /organizations — create another organization, caller as owner.
  //
  // SESSION-ONLY, a fence the sibling routes do not need. The router already
  // refuses project-scoped keys, but an ORGANIZATION key would otherwise pass:
  // that credential belongs to one org and carries its authority, and minting
  // a brand-new tenant is not authority over the org it was issued for. A
  // leaked automation key must not be able to provision.
  //
  // No `requireOrgAdmin` — this creates an org rather than touching the
  // current one, so the caller's role in `auth.organizationId` is irrelevant.
  // The service is the authorization: it fences the edition and the per-user
  // cap, and the caller is the only member of what it creates.
  app.post("/", async (c) => {
    const auth = c.get("auth");
    if (auth.scope !== "session") {
      throw new ServiceError(
        "FORBIDDEN",
        "Creating an organization requires a signed-in user.",
      );
    }

    const body = await c.req.json().catch(() => null);
    const input = parse(createOrganizationSchema, body);

    const organization = await withAudit(
      () => createOrganization(auth.userId, auth.userEmail, input.name),
      (created) => ({
        // The NEW org, not the one the request resolved to: this row belongs
        // to the tenant that came into existence, and reading its audit log
        // should show its own creation as the first entry.
        organizationId: created.id,
        userId: auth.userId,
        userEmail: auth.userEmail,
        service: AUDIT_SERVICES.ORGANIZATION,
        source: AUDIT_SOURCE.API,
        action: AUDIT_ACTIONS.CREATE,
        metadata: {
          organizationId: created.id,
          name: created.name,
          slug: created.slug,
          projectId: created.projectId,
        },
      }),
    );
    return c.json(organization, 201);
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
        // `organizationId` is duplicated into the metadata deliberately, as
        // `renameProject` duplicates `projectId`: the column scopes the row,
        // the metadata records what the change was ABOUT, and a log reader
        // filtering on one should not have to know about the other.
        metadata: {
          organizationId: auth.organizationId,
          change: "name",
          name: renamed.name,
        },
      }),
    );
    return c.json(organization);
  });

  return app;
};
