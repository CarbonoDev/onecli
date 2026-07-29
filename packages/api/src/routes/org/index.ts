import type { Hono } from "hono";
import type { ApiEnv } from "../../types";
import { orgMemberRoutes } from "./members";
import { orgInvitationRoutes } from "./invitations";
import { orgGroupRoutes } from "./groups";

/**
 * The OSS edition's `/v1/org/*` surface.
 *
 * OSS-ONLY BY CONSTRUCTION. This is never registered in the shared
 * `createApiApp` route table: it is mounted through
 * `CreateApiAppOptions.eeRoutes` from the OSS init seam
 * (`apps/web/src/lib/init/api.ts`), which every EE edition aliases away and
 * replaces with its own org router. Registering here rather than in `app.ts`
 * keeps the shared file free of edition-specific routes (upstream-merge
 * collisions) and avoids Hono's first-registration-wins silently shadowing an
 * EE route with an OSS one.
 *
 * Later org slices (invitations, groups, role mappings) append their
 * `app.route(...)` line here.
 */
export const registerOssOrgRoutes = (app: Hono<ApiEnv>) => {
  app.route("/org/members", orgMemberRoutes());
  app.route("/org/invitations", orgInvitationRoutes());
  app.route("/org/groups", orgGroupRoutes());
};
