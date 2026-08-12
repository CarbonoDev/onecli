import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./env", () => ({ GATEWAY_API_URL: "http://gateway.test" }));

/**
 * Fake `api_keys` table. `findMany` implements the *one* Prisma option under
 * test — `distinct: ["projectId"]` — so these tests are sensitive to the query
 * shape in the module, not just to its fetch calls. Drop `distinct` from
 * `invalidateGatewayCacheForOrg` and this fake starts returning every key,
 * which is exactly what the fan-out assertions below catch.
 */
interface KeyRow {
  key: string;
  projectId: string;
  organizationId: string;
}

const table = vi.hoisted(() => ({ rows: [] as KeyRow[] }));

interface FindManyArgs {
  where?: { project?: { organizationId?: string } };
  distinct?: string[];
}

vi.mock("@onecli/db", () => ({
  db: {
    apiKey: {
      findMany: (args: FindManyArgs) => {
        const organizationId = args.where?.project?.organizationId;
        const matched = table.rows.filter(
          (row) => row.organizationId === organizationId,
        );
        if (!args.distinct?.includes("projectId")) {
          return Promise.resolve(matched);
        }
        const seen = new Set<string>();
        return Promise.resolve(
          matched.filter((row) =>
            seen.has(row.projectId) ? false : (seen.add(row.projectId), true),
          ),
        );
      },
      findFirst: (args: { where: { projectId: string } }) =>
        Promise.resolve(
          table.rows.find((row) => row.projectId === args.where.projectId) ??
            null,
        ),
    },
  },
}));

import {
  invalidateGatewayCache,
  invalidateGatewayCacheForAccount,
  invalidateGatewayCacheForKeys,
  invalidateGatewayCacheForOrg,
} from "./gateway-invalidate";

interface Flush {
  url: string;
  headers: Record<string, string>;
}

const flushes: Flush[] = [];

/** The module fires and forgets, so tests await the microtask queue instead of
 * a returned promise. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const bearers = () =>
  flushes.map((f) => f.headers["authorization"]?.replace("Bearer ", "")).sort();

beforeEach(() => {
  flushes.length = 0;
  table.rows = [];
  vi.stubGlobal("fetch", (url: string, init: { headers?: HeadersInit }) => {
    flushes.push({
      url,
      headers: Object.fromEntries(
        new Headers(init.headers).entries(),
      ) as Record<string, string>,
    });
    return Promise.resolve(new Response(null, { status: 200 }));
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("invalidateGatewayCacheForOrg", () => {
  /**
   * The contract this pins, and why it is not the naive one.
   *
   * The gateway does not evict per API key. `/v1/cache/invalidate` resolves the
   * bearer to its project and then deletes by *project prefix* —
   * `connect:{org}:{project}:` and `app_injection:{org}:{project}:`
   * (apps/gateway/src/gateway.rs). Every cached entry for the project goes,
   * whichever key authenticated the call. Keys, meanwhile, are personal: one
   * per user per project (`ensureApiKey`), so a five-member project holds five
   * keys that all resolve to the same prefix.
   *
   * So `distinct: ["projectId"]` is not a coverage hole — it is the thing that
   * keeps an org-wide flush at one call per project instead of one per member,
   * with every extra call issuing a byte-identical delete.
   */
  it("flushes once per project, not once per key", async () => {
    table.rows = [
      { key: "oc_p1_alice", projectId: "p1", organizationId: "org1" },
      { key: "oc_p1_bob", projectId: "p1", organizationId: "org1" },
      { key: "oc_p1_carol", projectId: "p1", organizationId: "org1" },
      { key: "oc_p2_alice", projectId: "p2", organizationId: "org1" },
    ];

    invalidateGatewayCacheForOrg("org1");
    await settle();

    // Two projects, four keys, two flushes. Removing `distinct` makes it four,
    // three of which re-delete a `p1` prefix that is already gone.
    expect(flushes).toHaveLength(2);
    expect(bearers()).toEqual(["oc_p1_alice", "oc_p2_alice"]);
    expect(
      flushes.every((f) => f.url === "http://gateway.test/v1/cache/invalidate"),
    ).toBe(true);
  });

  it("covers every project in the org", async () => {
    table.rows = [
      { key: "oc_p1", projectId: "p1", organizationId: "org1" },
      { key: "oc_p2", projectId: "p2", organizationId: "org1" },
      { key: "oc_p3", projectId: "p3", organizationId: "org1" },
      // Another org's key must not be flushed by this org's mutation.
      { key: "oc_other", projectId: "p9", organizationId: "org2" },
    ];

    invalidateGatewayCacheForOrg("org1");
    await settle();

    expect(bearers()).toEqual(["oc_p1", "oc_p2", "oc_p3"]);
  });

  it("is a no-op for an org with no keys", async () => {
    invalidateGatewayCacheForOrg("org1");
    await settle();
    expect(flushes).toEqual([]);
  });
});

describe("invalidateGatewayCacheForAccount", () => {
  it("flushes one key for the project, which clears the project's prefix", async () => {
    table.rows = [
      { key: "oc_p1_alice", projectId: "p1", organizationId: "org1" },
      { key: "oc_p1_bob", projectId: "p1", organizationId: "org1" },
    ];

    invalidateGatewayCacheForAccount("p1");
    await settle();

    expect(flushes).toHaveLength(1);
    expect(bearers()).toEqual(["oc_p1_alice"]);
  });

  it("is a no-op for a project with no keys", async () => {
    invalidateGatewayCacheForAccount("p1");
    await settle();
    expect(flushes).toEqual([]);
  });
});

describe("invalidateGatewayCacheForKeys", () => {
  /**
   * The delete paths pass *every* key on purpose, and that is not in tension
   * with `distinct`: those keys are about to be deleted, and the gateway
   * authenticates the flush through an uncached `find_api_key`. Whichever key
   * still exists when the call lands is the one that works, so the redundancy
   * is the point.
   */
  it("flushes each key it is given", () => {
    invalidateGatewayCacheForKeys(["oc_a", "oc_b"]);
    expect(bearers()).toEqual(["oc_a", "oc_b"]);
  });
});

describe("invalidateGatewayCache", () => {
  it("forwards the caller's credentials and project scope", () => {
    invalidateGatewayCache(
      new Request("http://api.test/v1/secrets", {
        method: "POST",
        headers: {
          authorization: "Bearer oc_caller",
          cookie: "session=abc",
          "x-project-id": "p1",
        },
      }),
    );

    expect(flushes).toHaveLength(1);
    expect(flushes[0]!.headers).toMatchObject({
      authorization: "Bearer oc_caller",
      cookie: "session=abc",
      "x-project-id": "p1",
    });
  });

  it("omits headers the caller did not send", () => {
    invalidateGatewayCache(new Request("http://api.test/v1/secrets"));

    expect(flushes[0]!.headers["authorization"]).toBeUndefined();
    expect(flushes[0]!.headers["cookie"]).toBeUndefined();
    expect(flushes[0]!.headers["x-project-id"]).toBeUndefined();
  });
});
