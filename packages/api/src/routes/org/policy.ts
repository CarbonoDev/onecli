import { Hono } from "hono";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { ServiceError } from "../../services/errors";
import { registerPolicyRoutes } from "../policy";

/**
 * `/v1/org/policy` — the ORGANIZATION policy scope (the guardrail level the
 * gateway evaluates alongside each project's policy, taking the stricter
 * verdict).
 *
 * Same guard stack as `/v1/org/groups`, for the same reasons:
 *
 * `requireProject: false`: these are ORG-scoped routes, so a caller with no
 * project context (an org API key without `X-Project-Id`) must still get
 * through. `role: "admin"` makes the whole router admin-only — a plain member
 * gets a deterministic 403, which is what the web client renders (the org
 * policy page's admin-only notice) rather than retries.
 *
 * `role` alone is SCOPE-BLIND, so it is not sufficient on its own: a
 * project-scoped key (the credential an agent carries) resolves to its owning
 * user, and if that user happens to be an org admin the role check passes. Org
 * guardrails override every project's policy, so a leaked agent key would
 * otherwise be able to rewrite the rules its own traffic is evaluated against.
 * Org-wide authority requires an org-wide credential.
 *
 * Mounting a sub-app re-registers its `use("*")` guards under the mount path,
 * so these two guards — and `registerPolicyRoutes`'s own editing-flag gate —
 * cover every path beneath `/v1/org/policy` and only those. Registration order
 * puts the auth guards first, so an unauthenticated caller gets 401 rather
 * than "editing disabled".
 */
export const ossOrgPolicyRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", auth({ requireProject: false, role: "admin" }));
  app.use("*", async (c, next) => {
    if (c.get("auth").scope === "project") {
      throw new ServiceError(
        "FORBIDDEN",
        "Organization policy requires an organization-scoped credential.",
      );
    }
    return next();
  });

  registerPolicyRoutes(app, {
    // `organizationId` ONLY: `policyScope` requires exactly one key, and a
    // scope carrying both would let project rows into this scope's reads.
    resolveScope: (auth) => ({ organizationId: auth.organizationId }),
    // Not decoration: `withAudit` keys `invalidateGatewayCacheForOrg` off
    // `organizationId`, so this is the gateway cache-flush key. A missed flush
    // is an org guardrail that keeps enforcing for up to the cache window
    // after it was changed.
    auditScope: (auth) => ({ organizationId: auth.organizationId }),
  });
  return app;
};
