import { beforeEach, describe, expect, it, vi } from "vitest";

// `lastUsedAt` through the REAL app — the real `auth()` middleware, the real
// project/org gates, the real role resolver.
//
// A leaked key is only detectable if this column tracks *authentication*, so
// the suite is written around that word: every request that resolves to a
// caller records, every request that does not resolve to one records nothing,
// and a key in constant use writes at most once per throttle window. The
// last two are the ones that must never regress — a write on failed auth turns
// the column into a log of bearer strings someone guessed, and a write per
// request puts the database on the hot path of every gateway call.

const USER = "user-1";
const PROJECT_KEY = "oc_project-key";
const ORG_KEY = "oc_org_key";
const PROJECT_KEY_ID = "key-project-1";
const ORG_KEY_ID = "key-org-1";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "oss";
  process.env.SECRET_ENCRYPTION_KEY = "test-secret";
  process.env.OAUTH_STATE_SECRET = "test-secret";
});

const state = vi.hoisted(() => ({
  member: { role: "owner", status: "active" } as {
    role: string;
    status: string;
  } | null,
  /** The stored column, mutated by the write so the throttle is observable. */
  lastUsedAt: {} as Record<string, Date | null>,
}));

const updateMany = vi.hoisted(() =>
  vi.fn(
    async ({
      where,
      data,
    }: {
      where: { id: string };
      data: { lastUsedAt: Date };
    }) => {
      state.lastUsedAt[where.id] = data.lastUsedAt;
      return { count: 1 };
    },
  ),
);

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key?: string } }) => {
        if (where.key === ORG_KEY)
          return {
            id: ORG_KEY_ID,
            userId: USER,
            organizationId: "org-1",
            scope: "organization",
            lastUsedAt: state.lastUsedAt[ORG_KEY_ID] ?? null,
          };
        if (where.key === PROJECT_KEY)
          return {
            id: PROJECT_KEY_ID,
            userId: USER,
            projectId: "proj-1",
            lastUsedAt: state.lastUsedAt[PROJECT_KEY_ID] ?? null,
          };
        return null;
      },
      findFirst: async () => null,
      findMany: async () => [],
      updateMany,
    },
    user: {
      findUnique: async () => ({ id: USER, email: "user@example.com" }),
    },
    organizationMember: {
      findUnique: async () => state.member,
      findFirst: async () =>
        state.member ? { organizationId: "org-1" } : null,
    },
    project: {
      findUnique: async ({ where }: { where: { id?: string } }) =>
        where.id === "proj-1"
          ? { id: "proj-1", organizationId: "org-1" }
          : null,
      findFirst: async ({ where }: { where?: { id?: string } }) =>
        where?.id === undefined || where.id === "proj-1"
          ? { id: "proj-1", organizationId: "org-1" }
          : null,
    },
    projectAccess: { findFirst: async () => null },
    agent: { findMany: async () => [] },
    requestLog: { groupBy: async () => [] },
  },
}));

const { createApiApp } = await import("../../app");
const { ossRoleResolver } = await import("../../services/org-role-resolver");
const { initStrictApiKeyAuth } = await import("../../providers");

const app = createApiApp(
  { getSession: async () => null },
  { roleResolver: ossRoleResolver },
);

const bearer = (key: string, extra: Record<string, string> = {}) => ({
  headers: { Authorization: `Bearer ${key}`, ...extra },
});

const touchedIds = () =>
  updateMany.mock.calls.map((call) => call[0].where.id as string);

beforeEach(() => {
  state.member = { role: "owner", status: "active" };
  state.lastUsedAt = {};
  updateMany.mockClear();
  initStrictApiKeyAuth(false);
});

describe("a successful authentication records the key", () => {
  it("stamps a project key that authenticates", async () => {
    const res = await app.request("/v1/agents", bearer(PROJECT_KEY));

    expect(res.status).toBe(200);
    expect(touchedIds()).toEqual([PROJECT_KEY_ID]);
    expect(state.lastUsedAt[PROJECT_KEY_ID]).toBeInstanceOf(Date);
  });

  it("stamps an org key that authenticates", async () => {
    const res = await app.request("/v1/user", bearer(ORG_KEY));

    expect(res.status).toBe(200);
    expect(touchedIds()).toEqual([ORG_KEY_ID]);
  });

  it("stamps an org key scoped to a project inside its org", async () => {
    const res = await app.request(
      "/v1/agents",
      bearer(ORG_KEY, { "x-project-id": "proj-1" }),
    );

    expect(res.status).toBe(200);
    expect(touchedIds()).toEqual([ORG_KEY_ID]);
  });
});

describe("a failed authentication records nothing", () => {
  it("records nothing for a key that does not exist", async () => {
    const res = await app.request("/v1/agents", bearer("oc_nope"));

    expect(res.status).toBe(401);
    expect(updateMany).not.toHaveBeenCalled();
  });

  // The demotion gate. The key is real and the row was read — recording here
  // would report a revoked holder as an active user of the key.
  it("records nothing for a real key whose holder lost access", async () => {
    state.member = { role: "member", status: "active" };

    const res = await app.request("/v1/agents", bearer(PROJECT_KEY));

    expect(res.status).toBe(401);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("records nothing for a suspended holder", async () => {
    state.member = { role: "owner", status: "suspended" };

    const res = await app.request("/v1/agents", bearer(ORG_KEY));

    expect(res.status).toBe(401);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("records nothing when an org key names a project outside its org", async () => {
    state.member = { role: "admin", status: "active" };

    const res = await app.request(
      "/v1/agents",
      bearer(ORG_KEY, { "x-project-id": "proj-2" }),
    );

    expect(res.status).toBe(401);
    expect(updateMany).not.toHaveBeenCalled();
  });

  // A valid bearer that never resolved to a caller. The credential checked
  // out, but no authentication completed — `lastUsedAt` answers the second
  // question, not the first.
  it("records nothing when a valid org key omits the project header", async () => {
    initStrictApiKeyAuth(true);
    state.member = { role: "admin", status: "active" };

    const res = await app.request("/v1/agents", bearer(ORG_KEY));

    expect(res.status).toBe(401);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("records nothing for a request carrying no API key at all", async () => {
    const res = await app.request("/v1/agents");

    expect(res.status).toBe(401);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("the throttle keeps the write off the per-request path", () => {
  it("writes ONCE across a burst of authenticated requests", async () => {
    for (let i = 0; i < 25; i++) {
      const res = await app.request("/v1/agents", bearer(PROJECT_KEY));
      expect(res.status).toBe(200);
    }

    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it("writes again once the stored value has aged out of the window", async () => {
    await app.request("/v1/agents", bearer(PROJECT_KEY));
    expect(updateMany).toHaveBeenCalledTimes(1);

    const { API_KEY_LAST_USED_THROTTLE_MS } =
      await import("../../services/api-key-service");
    state.lastUsedAt[PROJECT_KEY_ID] = new Date(
      Date.now() - API_KEY_LAST_USED_THROTTLE_MS - 1000,
    );

    await app.request("/v1/agents", bearer(PROJECT_KEY));
    expect(updateMany).toHaveBeenCalledTimes(2);
  });

  it("throttles each key independently", async () => {
    await app.request("/v1/agents", bearer(PROJECT_KEY));
    await app.request("/v1/user", bearer(ORG_KEY));
    await app.request("/v1/agents", bearer(PROJECT_KEY));

    expect(touchedIds()).toEqual([PROJECT_KEY_ID, ORG_KEY_ID]);
  });
});

describe("authentication outcomes are unchanged by the recording", () => {
  it("still authenticates when the usage write fails outright", async () => {
    updateMany.mockRejectedValueOnce(new Error("connection reset"));

    const res = await app.request("/v1/agents", bearer(PROJECT_KEY));

    expect(res.status).toBe(200);
  });
});
