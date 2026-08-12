import { Hono } from "hono";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { ServiceError } from "../../services/errors";
import { getOrganizationUsage } from "../../services/usage-service";

/**
 * `/v1/org/usage` — recorded gateway request volume for the org, split by
 * agent.
 *
 * ## Why this router's guard stack differs from every other `/v1/org/*`
 *
 * Policy, budgets, secrets and friends are `role: "admin"`. Usage is
 * deliberately NOT: it is **member-visible with per-project fencing**. The
 * fencing is not a second check bolted on — `getOrganizationUsage` scopes the
 * aggregate through `listProjectIds`, which returns only the projects the
 * caller may reach — the same fence `listProjects` applies, selecting only the
 * ids — so a member sees their own projects' traffic and nothing else. A
 * member with no bindings gets a zeroed summary, not a 403 (same shape as
 * `GET /projects`, whose list IS its authorization).
 *
 * The org-scope-credential guard is kept, for the same reason budgets keeps
 * it: this is an ORG-wide read, and a project-scoped agent key must not be
 * able to enumerate volume across projects it was never issued for. Org
 * breadth requires an org credential.
 *
 * Read-only — not audited (CLAUDE.md).
 */
export const ossOrgUsageRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", auth({ requireProject: false }));
  app.use("*", async (c, next) => {
    if (c.get("auth").scope === "project") {
      throw new ServiceError(
        "FORBIDDEN",
        "Organization usage requires an organization-scoped credential.",
      );
    }
    return next();
  });

  app.get("/", async (c) => {
    const { organizationId, userId } = c.get("auth");
    return c.json(await getOrganizationUsage(organizationId, userId));
  });

  return app;
};
