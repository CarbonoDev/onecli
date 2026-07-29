import type { CreateApiAppOptions } from "@onecli/api";
import { ossNewProjectPolicySeeder } from "@onecli/api/services/policy-oss-cutover";
import { ossPolicyValidator } from "@onecli/api/services/policy-oss-locks";
import { ossRoleResolver } from "@onecli/api/services/org-role-resolver";
import { registerOssOrgRoutes } from "@onecli/api/routes/org";

/**
 * The OSS edition's API wiring. Every EE edition ALIASES THIS FILE AWAY
 * (`next.config.js` → `@/ee/init/api` or `@/ee/onprem/init/api`), so anything
 * here is OSS-only by construction:
 *
 * - the new-project seeder gives fresh projects their published Default Rule —
 *   the per-project enforce signal — pinned to ALLOW since step 6;
 * - the policy validator LOCKS granular resource scoping (a OneCLI Cloud
 *   capability the OSS gateway does not enforce) with a loud 422;
 * - the role resolver backs `CAPS.rbac` (now true for OSS): it reads the
 *   org-membership row and is a hard prerequisite for the flag — with rbac on
 *   and no resolver, every access check reads "no role" and denies;
 * - the org routes register the OSS `/v1/org/*` surface.
 *
 * `eeRoutes` reads oddly for an OSS registration, but it IS the intended seam:
 * it is the one hook `createApiApp` exposes for edition-owned routes, and every
 * EE edition aliases this whole file away, so nothing here can collide with
 * theirs. Registering these routes in the shared `app.ts` instead would put
 * edition-specific paths in an upstream-merged file and let Hono's
 * first-registration-wins silently shadow an EE route.
 */
export const eeOverrides: CreateApiAppOptions | undefined = {
  newOrgPolicySeeder: ossNewProjectPolicySeeder,
  policyValidator: ossPolicyValidator,
  roleResolver: ossRoleResolver,
  eeRoutes: registerOssOrgRoutes,
};
