import { Hono } from "hono";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { ServiceError } from "../../services/errors";
import { registerConnectionRoutes } from "../connections";

/**
 * `/v1/org/connections` — the ORGANIZATION connection scope: app connections
 * that inherit into every project in the org.
 *
 * Same guard stack as `/v1/org/policy` and `/v1/org/budgets`, for the same
 * reasons: `requireProject: false` (an org API key carries no `X-Project-Id`),
 * `role: "admin"` for a deterministic 403 the web client renders, and an
 * org-credential guard on top because `role` is SCOPE-BLIND — a project-scoped
 * agent key whose user happens to be an org admin must not be able to rename
 * or disconnect a credential every project in the org inherits.
 *
 * CONNECTING at org scope is deliberately not here: `POST /v1/apps/:provider/
 * connect` and the OAuth authorize/callback pair still hard-400 an org-scope
 * connect, and that is a separate slice.
 */
export const ossOrgConnectionRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", auth({ requireProject: false, role: "admin" }));
  app.use("*", async (c, next) => {
    if (c.get("auth").scope === "project") {
      throw new ServiceError(
        "FORBIDDEN",
        "Organization connections require an organization-scoped credential.",
      );
    }
    return next();
  });

  registerConnectionRoutes(app, {
    // `organizationId` ONLY. `apiFetch` attaches `X-Project-Id` whenever the
    // cookie exists, so the auth context here carries a projectId too — and a
    // two-key scope would make `scopeWhere` OR the project's own rows back into
    // this scope's reads.
    readScope: (auth) => ({ organizationId: auth.organizationId }),
    // Same reason on the write side: only the org's own rows are reachable, so
    // a project row can never be renamed or disconnected from this surface.
    ownership: (auth) => ({ organizationId: auth.organizationId }),
  });

  return app;
};
