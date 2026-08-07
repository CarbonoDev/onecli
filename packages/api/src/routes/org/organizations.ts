import { Hono } from "hono";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { ServiceError } from "../../services/errors";
import { listUserOrganizations } from "../../services/organization-service";

/**
 * `/v1/organizations` — the org switcher's source.
 *
 * Guard stack mirrors `/v1/projects`: `requireProject: false` (this is not a
 * project-scoped surface), no `role` filter (every active member may see the
 * orgs they belong to, not just admins), and the same `scope === "project"`
 * fence — a project-scoped key is the credential an AGENT carries, and a leaked
 * agent key must not be able to enumerate its owner's other organizations.
 *
 * Read-only, so there is nothing to audit and nothing to invalidate.
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

  return app;
};
