import type { Hono } from "hono";
import type { ApiEnv } from "../../types";
import { orgMemberRoutes } from "./members";
import { orgInvitationRoutes } from "./invitations";
import { orgGroupRoutes } from "./groups";
import { orgRoleMappingRoutes } from "./role-mappings";
import { ossOrgPolicyRoutes } from "./policy";
import { ossOrgBudgetRoutes } from "./budgets";
import { ossProjectRoutes } from "./projects";
import { ossOrganizationRoutes } from "./organizations";

/**
 * The OSS edition's EDITION SURFACE: `/v1/org/*` PLUS `/v1/projects/*`.
 *
 * OSS-ONLY BY CONSTRUCTION. This is never registered in the shared
 * `createApiApp` route table: it is mounted through
 * `CreateApiAppOptions.eeRoutes` from the OSS init seam
 * (`apps/web/src/lib/init/api.ts`), which every EE edition aliases away and
 * replaces with its own org router. Registering here rather than in `app.ts`
 * keeps the shared file free of edition-specific routes (upstream-merge
 * collisions) and avoids Hono's first-registration-wins silently shadowing an
 * EE route with an OSS one — which is exactly why project administration is
 * registered here too, even though its URL is not under `/org`. The exported
 * name stays `registerOssOrgRoutes`: renaming it buys nothing and touches the
 * init seam plus every route test.
 *
 * Mounting a sub-app re-registers its `use("*")` guards under the mount path,
 * so each sub-app's guard stack covers every path beneath it — and only those.
 * `/projects` therefore owns the whole `/v1/projects/*` namespace in OSS; do
 * not register a second router there.
 *
 * Later org slices (role mappings, …) append their `app.route(...)` line here.
 */
export const registerOssOrgRoutes = (app: Hono<ApiEnv>) => {
  app.route("/org/members", orgMemberRoutes());
  app.route("/org/invitations", orgInvitationRoutes());
  app.route("/org/groups", orgGroupRoutes());
  app.route("/org/role-mappings", orgRoleMappingRoutes());
  app.route("/org/policy", ossOrgPolicyRoutes());
  app.route("/org/budgets", ossOrgBudgetRoutes());
  app.route("/projects", ossProjectRoutes());
  app.route("/organizations", ossOrganizationRoutes());
};
