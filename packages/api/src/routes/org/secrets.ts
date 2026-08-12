import { Hono } from "hono";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { ServiceError } from "../../services/errors";
import { registerSecretRoutes } from "../secrets";

/**
 * `/v1/org/secrets` — the ORGANIZATION secret scope: credentials that inherit
 * into every project in the org (that inheritance is the project router's
 * two-key read scope, not anything this router does).
 *
 * Same guard stack as `/v1/org/policy` and `/v1/org/budgets`, for the same
 * reasons: `requireProject: false` so an org API key with no `X-Project-Id`
 * still gets through, `role: "admin"` so a plain member gets a deterministic
 * 403 the web client can render, and an org-credential guard on top because
 * `role` is SCOPE-BLIND — a project-scoped agent key whose user happens to be
 * an org admin would otherwise be able to mint a credential every project in
 * the org inherits.
 */
export const ossOrgSecretRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", auth({ requireProject: false, role: "admin" }));
  app.use("*", async (c, next) => {
    if (c.get("auth").scope === "project") {
      throw new ServiceError(
        "FORBIDDEN",
        "Organization secrets require an organization-scoped credential.",
      );
    }
    return next();
  });

  registerSecretRoutes(app, {
    // `organizationId` ONLY, on BOTH scopes. `apiFetch` attaches `X-Project-Id`
    // whenever the cookie exists, so the auth context here carries a projectId
    // too — and a two-key scope would make `scopeWhere` OR the project's own
    // rows back into this scope's reads.
    readScope: (auth) => ({ organizationId: auth.organizationId }),
    writeScope: (auth) => ({ organizationId: auth.organizationId }),
    // Not decoration: `withAudit` keys `invalidateGatewayCacheForOrg` off
    // `organizationId`, so this is the gateway cache-flush key. A missed flush
    // is an org secret that keeps injecting for up to the cache window after it
    // was deleted.
    auditScope: (auth) => ({ organizationId: auth.organizationId }),
  });

  return app;
};
