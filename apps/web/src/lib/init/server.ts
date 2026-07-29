import { initRoleResolver } from "@onecli/api";
import { ossRoleResolver } from "@onecli/api/services/org-role-resolver";

/**
 * OSS server-side initialization. Every EE edition ALIASES THIS FILE AWAY
 * (`next.config.js` → `@/ee/init/server` / `@/ee/onprem/init/server`), so
 * anything here is OSS-only by construction.
 *
 * The role resolver is registered here as well as through `createApiApp`
 * (`@/lib/init/api`): with `CAPS.rbac` on, the SERVER-ACTION surface also runs
 * access checks (`resolveProjectContext` → `canAccessProjectAsUser`), and that
 * module graph never imports the Hono app. Without this the resolver would be
 * null there and every header-scoped project check would fail closed.
 * `initRoleResolver` just assigns the singleton, so installing the same
 * resolver from both seams is safe.
 */
initRoleResolver(ossRoleResolver);
