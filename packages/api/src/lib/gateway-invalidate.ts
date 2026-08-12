import { db } from "@onecli/db";
import { GATEWAY_API_URL } from "./env";

export const invalidateGatewayCache = (request: Request) => {
  const authorization = request.headers.get("authorization");
  const cookie = request.headers.get("cookie");
  // Forward the project the request was scoped to. The cloud gateway requires
  // X-Project-Id for session (Cognito) auth — without it the flush 401s (and
  // previously hit the user's *default* project instead of this one). API-key
  // auth ignores it (the key carries its project), so this is safe for the
  // SDK/CLI and for OSS.
  const projectId = request.headers.get("x-project-id");

  const headers: Record<string, string> = {};
  if (authorization) headers["authorization"] = authorization;
  if (cookie) headers["cookie"] = cookie;
  if (projectId) headers["x-project-id"] = projectId;

  fetch(`${GATEWAY_API_URL}/v1/cache/invalidate`, {
    method: "POST",
    headers,
  }).catch(() => {});
};

/**
 * Flush the gateway's cached config for specific API keys directly. Use this
 * when the keys are about to be deleted, so they can no longer be looked up
 * from the database: capture them, flush, THEN delete.
 *
 * The order is load-bearing. The gateway authenticates `/v1/cache/invalidate`
 * by resolving the bearer through an uncached `find_api_key` query, so a key
 * that has already been deleted cannot flush its own entry — the request just
 * 401s and the rejection is swallowed.
 */
export const invalidateGatewayCacheForKeys = (keys: string[]) => {
  for (const key of keys) {
    fetch(`${GATEWAY_API_URL}/v1/cache/invalidate`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
    }).catch(() => {});
  }
};

/**
 * Flush a single project's cached config.
 *
 * One key is enough, and that is not an approximation. The gateway's
 * `/v1/cache/invalidate` resolves the bearer to its project and then deletes by
 * *project prefix* — `connect:{org}:{project}:` and
 * `app_injection:{org}:{project}:` (apps/gateway/src/gateway.rs) — so a single
 * accepted call drops every entry the project has, across every agent token and
 * host. Which of the project's keys carried the call makes no difference.
 *
 * Known limit: a project holding no API key at all cannot be flushed from here,
 * because the gateway has no other credential to accept. Keys are minted lazily
 * per user (`ensureApiKey`), so a project whose agents were provisioned without
 * anyone opening the dashboard has cached entries and no way to evict them
 * early; they age out on the TTL. Closing that needs a gateway-side auth change,
 * not a wider query.
 */
export const invalidateGatewayCacheForAccount = (projectId: string) => {
  db.apiKey
    .findFirst({ where: { projectId }, select: { key: true } })
    .then((apiKey) => {
      if (!apiKey) return;
      invalidateGatewayCacheForKeys([apiKey.key]);
    })
    .catch(() => {});
};

/**
 * Flush every project in an organization — for org-scoped writes (policy,
 * budgets, org secrets/connections/apps) that change what all of them enforce.
 *
 * `distinct: ["projectId"]` is load-bearing, and it is not a coverage hole.
 * Per `invalidateGatewayCacheForAccount` above, one accepted call clears a
 * project's whole prefix, and API keys are personal — one per user per project
 * (`ensureApiKey`). Without the `distinct` an org-wide flush would scale with
 * *members* rather than projects (a 50-project org with 10 members each: 500
 * calls instead of 50), and 450 of those would be byte-identical re-deletes of
 * a prefix already gone. Coverage stays the same; only the fan-out grows.
 *
 * The fan-out is therefore bounded by project count, which keeps it small
 * enough to fire unbatched. `gateway-invalidate.test.ts` pins this.
 */
export const invalidateGatewayCacheForOrg = (organizationId: string) => {
  db.apiKey
    .findMany({
      where: { project: { organizationId } },
      select: { key: true },
      distinct: ["projectId"],
    })
    .then((keys) => invalidateGatewayCacheForKeys(keys.map((k) => k.key)))
    .catch(() => {});
};
