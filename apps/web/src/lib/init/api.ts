import type { CreateApiAppOptions } from "@onecli/api";
import { ossNewProjectPolicySeeder } from "@onecli/api/services/policy-oss-cutover";

/**
 * The OSS edition's API wiring. Every EE edition ALIASES THIS FILE AWAY
 * (`next.config.js` → `@/ee/init/api` or `@/ee/onprem/init/api`), so anything
 * here is OSS-only by construction:
 *
 * - the new-project seeder gives fresh projects their published Default Rule —
 *   the per-project enforce signal — pinned to ALLOW since step 6.
 *
 * No `policyValidator` is wired: the provider-hook default is permissive, so
 * granular resource scoping and cloud-only app targets are accepted at the API
 * layer. The gateway does not yet ENFORCE resource scoping — see Tier 3.
 */
export const eeOverrides: CreateApiAppOptions | undefined = {
  newOrgPolicySeeder: ossNewProjectPolicySeeder,
};
