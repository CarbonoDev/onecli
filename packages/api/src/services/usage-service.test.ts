import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory `@onecli/db` covering exactly what `getOrganizationUsage` touches:
// two `requestLog.groupBy` aggregates inside one `$transaction`, plus the
// agent-name lookup. `groupBy` is implemented honestly over a row store (so
// the window predicate and the per-agent split are really exercised) with an
// escape hatch, `injectedOverride`, for the one case an honest aggregate can
// never produce: an injected count exceeding the total, which is what the
// clamp exists to survive.

interface LogRow {
  projectId: string;
  agentId: string;
  injectionCount: number;
  createdAt: Date;
}

interface AgentRow {
  id: string;
  projectId: string;
  name: string;
}

interface GroupByArgs {
  where: {
    projectId: { in: string[] };
    createdAt: { gte: Date; lt: Date };
    injectionCount?: { gt: number };
  };
}

const store = vi.hoisted(() => ({
  logs: [] as LogRow[],
  agents: [] as AgentRow[],
  /** The ids `listProjectIds` resolves for the caller — the service's fence. */
  projectIds: [] as string[],
  /** Every `where` the service handed to `groupBy`, in call order. */
  groupByWheres: [] as GroupByArgs["where"][],
  /** Set to canned rows to force the injected aggregate out of range. */
  injectedOverride: null as
    | { agentId: string; _count: { _all: number } }[]
    | null,
  /**
   * How many times the aggregate pair ran. Used ONLY to assert that the
   * empty-project path issues no queries at all — it says nothing about
   * isolation, which `$transaction` here (a `Promise.all`) cannot model.
   */
  transactions: 0,
  agentFindManyCalls: 0,
}));

vi.mock("@onecli/db", () => {
  const groupBy = async (args: GroupByArgs) => {
    store.groupByWheres.push(args.where);
    const injectedOnly = args.where.injectionCount !== undefined;
    if (injectedOnly && store.injectedOverride) return store.injectedOverride;

    const matching = store.logs.filter(
      (r) =>
        args.where.projectId.in.includes(r.projectId) &&
        r.createdAt.getTime() >= args.where.createdAt.gte.getTime() &&
        r.createdAt.getTime() < args.where.createdAt.lt.getTime() &&
        (!injectedOnly || r.injectionCount > 0),
    );
    const counts = new Map<string, number>();
    for (const row of matching) {
      counts.set(row.agentId, (counts.get(row.agentId) ?? 0) + 1);
    }
    return [...counts].map(([agentId, n]) => ({
      agentId,
      _count: { _all: n },
    }));
  };

  return {
    db: {
      requestLog: { groupBy },
      agent: {
        findMany: async ({
          where,
        }: {
          where: { id: { in: string[] }; projectId: { in: string[] } };
        }) => {
          store.agentFindManyCalls++;
          return store.agents
            .filter(
              (a) =>
                where.id.in.includes(a.id) &&
                where.projectId.in.includes(a.projectId),
            )
            .map((a) => ({ id: a.id, name: a.name }));
        },
      },
      $transaction: async (promises: Promise<unknown>[]) => {
        store.transactions++;
        return Promise.all(promises);
      },
    },
  };
});

// The service takes its scope from the id-only entry point, NOT `listProjects`
// — same fence, no card-grid counts. Mocking the one it actually calls is what
// keeps this suite from witnessing a shape the service no longer has.
vi.mock("./project-service", () => ({
  listProjectIds: async () => store.projectIds,
}));

const { getOrganizationUsage, USAGE_WINDOW_MS } =
  await import("./usage-service");

const NOW = Date.UTC(2026, 7, 11, 12, 0, 0);
const ORG = "org-1";
const USER = "user-1";

/** `days` before NOW, inside the window unless `days > 30`. */
const ago = (days: number) => new Date(NOW - days * 24 * 60 * 60 * 1000);

const log = (
  agentId: string,
  injectionCount: number,
  days = 1,
  projectId = "proj-1",
): LogRow => ({ projectId, agentId, injectionCount, createdAt: ago(days) });

beforeEach(() => {
  store.logs = [];
  store.agents = [
    { id: "agent-a", projectId: "proj-1", name: "Helm" },
    { id: "agent-b", projectId: "proj-1", name: "Bridge" },
    { id: "agent-c", projectId: "proj-2", name: "Beacon" },
  ];
  store.projectIds = ["proj-1", "proj-2"];
  store.groupByWheres = [];
  store.injectedOverride = null;
  store.transactions = 0;
  store.agentFindManyCalls = 0;
});

describe("getOrganizationUsage — period bounds", () => {
  it("reports a rolling 30-day window ending now", async () => {
    const usage = await getOrganizationUsage(ORG, USER, NOW);

    expect(usage.periodEnd).toBe(new Date(NOW).toISOString());
    expect(usage.periodStart).toBe(
      new Date(NOW - USAGE_WINDOW_MS).toISOString(),
    );
    expect(USAGE_WINDOW_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("bounds both aggregates by that same window, never unbounded", async () => {
    await getOrganizationUsage(ORG, USER, NOW);

    expect(store.groupByWheres).toHaveLength(2);
    for (const where of store.groupByWheres) {
      expect(where.createdAt.gte.getTime()).toBe(NOW - USAGE_WINDOW_MS);
      // Bounded at both ends, so a future-dated row can't land in a window
      // the UI labels as ending now.
      expect(where.createdAt.lt.getTime()).toBe(NOW);
      expect(where.projectId.in).toEqual(["proj-1", "proj-2"]);
    }
    // Exactly one is the injected slice; the other counts everything.
    expect(
      store.groupByWheres.filter((w) => w.injectionCount?.gt === 0),
    ).toHaveLength(1);
  });

  it("excludes rows older than the window", async () => {
    store.logs = [log("agent-a", 1, 1), log("agent-a", 1, 45)];

    const usage = await getOrganizationUsage(ORG, USER, NOW);

    expect(usage.requests).toBe(1);
  });

  it("excludes a future-dated row from a window that ends now", async () => {
    // A gateway with a fast clock. Without the `lt` bound this would count.
    store.logs = [log("agent-a", 1, 1), log("agent-a", 1, -3)];

    const usage = await getOrganizationUsage(ORG, USER, NOW);

    expect(usage.requests).toBe(1);
  });

  // NOTE: there is deliberately NO test asserting the two aggregates read one
  // snapshot. They don't: `$transaction([...])` inherits Postgres' READ
  // COMMITTED default (nothing in the repo sets `isolationLevel`), so each
  // statement takes its own snapshot. The invariant is held by the `Math.min`
  // clamp instead, which "never reports more integration calls than requests"
  // below actually exercises. A `store.transactions === 1` assertion against a
  // `Promise.all` mock would only have restated the mock.
});

describe("getOrganizationUsage — totals", () => {
  it("sums the totals from the per-agent rows", async () => {
    store.logs = [
      log("agent-a", 1),
      log("agent-a", 0),
      log("agent-a", 2),
      log("agent-b", 1),
      log("agent-c", 0, 1, "proj-2"),
    ];

    const usage = await getOrganizationUsage(ORG, USER, NOW);

    expect(usage.requests).toBe(
      usage.agents.reduce((n, a) => n + a.requests, 0),
    );
    expect(usage.integrationCalls).toBe(
      usage.agents.reduce((n, a) => n + a.integrationCalls, 0),
    );
    expect(usage.requests).toBe(5);
    expect(usage.integrationCalls).toBe(3);
  });

  it("orders agents by requests, busiest first", async () => {
    store.logs = [
      log("agent-b", 1),
      log("agent-a", 1),
      log("agent-a", 1),
      log("agent-a", 1),
      log("agent-c", 1, 1, "proj-2"),
      log("agent-c", 1, 1, "proj-2"),
    ];

    const usage = await getOrganizationUsage(ORG, USER, NOW);

    expect(usage.agents.map((a) => a.agentName)).toEqual([
      "Helm",
      "Beacon",
      "Bridge",
    ]);
  });

  it("never reports more integration calls than requests", async () => {
    store.logs = [log("agent-a", 1), log("agent-a", 0)];
    // A skew the transaction is meant to prevent; the clamp is the second line.
    store.injectedOverride = [{ agentId: "agent-a", _count: { _all: 99 } }];

    const usage = await getOrganizationUsage(ORG, USER, NOW);

    expect(usage.agents[0]!.requests).toBe(2);
    expect(usage.agents[0]!.integrationCalls).toBe(2);
    expect(usage.integrationCalls).toBeLessThanOrEqual(usage.requests);
  });
});

describe("getOrganizationUsage — agent resolution", () => {
  it("keeps a row whose agent no longer exists, so the table still sums to the cards", async () => {
    store.logs = [
      log("agent-a", 1),
      log("agent-deleted", 1),
      log("agent-deleted", 0),
    ];

    const usage = await getOrganizationUsage(ORG, USER, NOW);

    const dangling = usage.agents.find((a) => a.agentId === "agent-deleted");
    expect(dangling).toEqual({
      agentId: "agent-deleted",
      agentName: null,
      requests: 2,
      integrationCalls: 1,
    });
    expect(usage.requests).toBe(3);
    expect(usage.requests).toBe(
      usage.agents.reduce((n, a) => n + a.requests, 0),
    );
  });

  it("does not resolve names outside the caller's projects", async () => {
    // `agent-c` lives in proj-2, which this caller cannot reach.
    store.projectIds = ["proj-1"];
    store.logs = [log("agent-c", 1, 1, "proj-1")];

    const usage = await getOrganizationUsage(ORG, USER, NOW);

    expect(usage.agents[0]!.agentName).toBeNull();
  });
});

describe("getOrganizationUsage — no reachable projects", () => {
  it("returns a zeroed summary with real bounds, not an error", async () => {
    store.projectIds = [];

    const usage = await getOrganizationUsage(ORG, USER, NOW);

    expect(usage).toEqual({
      periodStart: new Date(NOW - USAGE_WINDOW_MS).toISOString(),
      periodEnd: new Date(NOW).toISOString(),
      requests: 0,
      integrationCalls: 0,
      agents: [],
    });
  });

  it("issues no aggregate at all when there is nothing to scope to", async () => {
    store.projectIds = [];

    await getOrganizationUsage(ORG, USER, NOW);

    expect(store.groupByWheres).toHaveLength(0);
    expect(store.transactions).toBe(0);
  });

  it("skips the name lookup when the window produced no rows", async () => {
    store.logs = [];

    const usage = await getOrganizationUsage(ORG, USER, NOW);

    expect(usage.agents).toEqual([]);
    expect(store.agentFindManyCalls).toBe(0);
  });
});
