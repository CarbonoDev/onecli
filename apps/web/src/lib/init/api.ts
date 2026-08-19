import type { CreateApiAppOptions } from "@onecli/api";
import { ossNewProjectPolicySeeder } from "@onecli/api/services/policy-oss-cutover";
import { ossRoleResolver } from "@onecli/api/services/org-role-resolver";
import { registerOssOrgRoutes } from "@onecli/api/routes/org";
import { applyProjectAgentDefaults } from "@onecli/api/services/agent-default-connections-service";

/**
 * The OSS edition's API wiring. Every EE edition ALIASES THIS FILE AWAY
 * (`next.config.js` → `@/ee/init/api` or `@/ee/onprem/init/api`), so anything
 * here is OSS-only by construction:
 *
 * - the new-project seeder gives fresh projects their published Default Rule —
 *   the per-project enforce signal — pinned to ALLOW since step 6;
 * - the role resolver backs `CAPS.rbac` (now true for OSS): it reads the
 *   org-membership row and is a hard prerequisite for the flag — with rbac on
 *   and no resolver, every access check reads "no role" and denies;
 * - the org routes register the OSS `/v1/org/*` surface.
 *
 * No `policyValidator` is wired: the provider-hook default is permissive, so
 * granular resource scoping and cloud-only app targets are accepted at the API
 * layer (the gateway enforces resource scoping — see the Tier 3 work).
 *
 * `eeRoutes` reads oddly for an OSS registration, but it IS the intended seam:
 * it is the one hook `createApiApp` exposes for edition-owned routes, and every
 * EE edition aliases this whole file away, so nothing here can collide with
 * theirs. Registering these routes in the shared `app.ts` instead would put
 * edition-specific paths in an upstream-merged file and let Hono's
 * first-registration-wins silently shadow an EE route.
 *
 * `resourceHooks.afterCreateAgent` applies the project's default-connections
 * template to every brand-new agent (`agent-default-connections-service.ts`) —
 * the OSS answer to "an agent shouldn't be born with zero access and no way to
 * tell." `beforeCreateAgent` stays a no-op: OSS has no agent quota to gate.
 */
export const eeOverrides: CreateApiAppOptions | undefined = {
  newOrgPolicySeeder: ossNewProjectPolicySeeder,
  roleResolver: ossRoleResolver,
  eeRoutes: registerOssOrgRoutes,
  resourceHooks: {
    beforeCreateAgent: async () => {},
    beforeCreateSecret: async () => {},
    afterCreateAgent: (organizationId, projectId, agentId) =>
      applyProjectAgentDefaults({ projectId, organizationId }, agentId),
  },
};
