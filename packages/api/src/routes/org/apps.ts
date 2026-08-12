import { Hono } from "hono";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { ServiceError } from "../../services/errors";
import { registerAppConfigRoutes } from "../app-config";

/**
 * `/v1/org/apps/*` — the ORGANIZATION app-configuration scope: the OAuth client
 * credentials (`/:provider/config*`) and host blocks (`/:provider/blocklist*`)
 * that apply across every project in the org.
 *
 * Same guard stack as `/v1/org/policy` and `/v1/org/budgets`, for the same
 * reasons: `requireProject: false` (an org API key carries no `X-Project-Id`),
 * `role: "admin"` for a deterministic 403 the web client renders, and an
 * org-credential guard on top because `role` is SCOPE-BLIND — an org block
 * overrides every project's view of that host, so a project-scoped agent key
 * must not be able to author or lift one.
 *
 * Deliberately NOT here: the connect flows. `GET /v1/apps/:provider/authorize`
 * and `POST /v1/apps/:provider/connect` still hard-400 an org-scope connect;
 * that is a separate slice.
 */
export const ossOrgAppRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", auth({ requireProject: false, role: "admin" }));
  app.use("*", async (c, next) => {
    if (c.get("auth").scope === "project") {
      throw new ServiceError(
        "FORBIDDEN",
        "Organization app configuration requires an organization-scoped credential.",
      );
    }
    return next();
  });

  registerAppConfigRoutes(app, {
    // `organizationId` ONLY, on both scopes. `apiFetch` attaches `X-Project-Id`
    // whenever the cookie exists, so the auth context here carries a projectId
    // too — and a two-key scope would make `scopeWhere` OR the project's own
    // rows back into this scope's reads (and `appConfigKey` resolve the wrong
    // unique).
    resolveScope: (auth) => ({ organizationId: auth.organizationId }),
    // Nothing above the org tier to inherit from, so the read scope is the
    // same: the blocklist panel here shows the org's own rules only.
    readScope: (auth) => ({ organizationId: auth.organizationId }),
    // Not decoration: `withAudit` keys `invalidateGatewayCacheForOrg` off
    // `organizationId`, so this is the gateway cache-flush key across every
    // project in the org.
    auditScope: (auth) => ({ organizationId: auth.organizationId }),
  });

  return app;
};
