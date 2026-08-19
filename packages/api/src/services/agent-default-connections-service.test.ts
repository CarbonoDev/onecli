import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory `@onecli/db` mock covering only what this service touches:
// `projectAgentDefaultConnection` (the template rows) and `appConnection`
// (pool membership + provider/metadata lookups). `setConnectionGrant` itself
// is mocked at the module boundary — its own behavior is proven by
// grants-service.test.ts; this file only proves the template CRUD and that
// `applyProjectAgentDefaults` calls it correctly and tolerates a failure.

interface DefaultRow {
  projectId: string;
  connectionId: string;
  access: string;
  allow: string[];
  ask: string[];
  resources: unknown;
  createdByUserId: string | null;
}

interface ConnectionRow {
  id: string;
  projectId?: string;
  organizationId?: string;
  scope: string;
  provider: string;
  label: string | null;
  metadata: Record<string, unknown> | null;
}

const store = vi.hoisted(() => ({
  defaults: [] as DefaultRow[],
  connections: [] as ConnectionRow[],
}));

vi.mock("@onecli/db", () => ({
  Prisma: { JsonNull: "JsonNull" },
  db: {
    appConnection: {
      findFirst: async ({
        where,
      }: {
        where: {
          id: string;
          OR: { projectId?: string; organizationId?: string; scope?: string }[];
        };
      }) => {
        const conn = store.connections.find((c) => c.id === where.id);
        if (!conn) return null;
        const inPool = where.OR.some(
          (clause) =>
            (clause.projectId && conn.projectId === clause.projectId) ||
            (clause.organizationId &&
              conn.organizationId === clause.organizationId &&
              conn.scope === clause.scope),
        );
        return inPool ? conn : null;
      },
    },
    projectAgentDefaultConnection: {
      findMany: async ({ where }: { where: { projectId: string } }) =>
        store.defaults
          .filter((d) => d.projectId === where.projectId)
          .map((d) => ({
            ...d,
            connection: (() => {
              const c = store.connections.find((c) => c.id === d.connectionId)!;
              return { provider: c.provider, label: c.label, scope: c.scope };
            })(),
          })),
      deleteMany: async ({
        where,
      }: {
        where: { projectId: string; connectionId: string };
      }) => {
        const before = store.defaults.length;
        store.defaults = store.defaults.filter(
          (d) =>
            !(
              d.projectId === where.projectId &&
              d.connectionId === where.connectionId
            ),
        );
        return { count: before - store.defaults.length };
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: {
          projectId_connectionId: { projectId: string; connectionId: string };
        };
        create: DefaultRow;
        update: Partial<DefaultRow>;
      }) => {
        const { projectId, connectionId } = where.projectId_connectionId;
        const existing = store.defaults.find(
          (d) => d.projectId === projectId && d.connectionId === connectionId,
        );
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        store.defaults.push(create);
        return create;
      },
    },
  },
}));

const setConnectionGrant = vi.fn(async () => ({
  grants: {
    agentId: "a1",
    mode: "grants" as const,
    connections: [],
    secrets: [],
  },
  changed: true,
  ruleIds: [],
  generation: null,
}));
vi.mock("./grants-service", () => ({ setConnectionGrant }));

const assertToolIdsValid = vi.fn();
vi.mock("../apps/app-permissions/validate", () => ({
  assertToolIdsValid: (...args: unknown[]) => assertToolIdsValid(...args),
}));

const {
  listProjectAgentDefaults,
  setProjectAgentDefault,
  removeProjectAgentDefault,
  applyProjectAgentDefaults,
} = await import("./agent-default-connections-service");
const { ServiceError } = await import("./errors");

const SCOPE = { projectId: "proj-1", organizationId: "org-1" };

beforeEach(() => {
  store.defaults = [];
  store.connections = [
    {
      id: "conn-project",
      projectId: "proj-1",
      scope: "project",
      provider: "github",
      label: "GitHub",
      metadata: null,
    },
    {
      id: "conn-org",
      organizationId: "org-1",
      scope: "organization",
      provider: "anthropic",
      label: "Anthropic",
      metadata: null,
    },
    {
      id: "conn-foreign",
      projectId: "proj-other",
      scope: "project",
      provider: "gmail",
      label: "Gmail",
      metadata: null,
    },
  ];
  setConnectionGrant.mockClear();
  assertToolIdsValid.mockClear();
});

describe("listProjectAgentDefaults", () => {
  it("returns an empty template for a project with no defaults", async () => {
    expect(await listProjectAgentDefaults(SCOPE)).toEqual([]);
  });

  it("projects the connection's provider/label/scope alongside the stored access", async () => {
    store.defaults = [
      {
        projectId: "proj-1",
        connectionId: "conn-project",
        access: "full",
        allow: [],
        ask: [],
        resources: null,
        createdByUserId: "u1",
      },
    ];
    expect(await listProjectAgentDefaults(SCOPE)).toEqual([
      {
        connectionId: "conn-project",
        provider: "github",
        label: "GitHub",
        scope: "project",
        access: "full",
        allow: [],
        ask: [],
        resources: null,
      },
    ]);
  });
});

describe("setProjectAgentDefault — the config surface", () => {
  it("rejects a connection outside the project's pool (not owned by the project, not org-shared)", async () => {
    await expect(
      setProjectAgentDefault(
        SCOPE,
        "conn-foreign",
        { access: "full", resources: null },
        "u1",
      ),
    ).rejects.toThrow(ServiceError);
    expect(store.defaults).toHaveLength(0);
  });

  it("accepts an org-shared connection, not just a project-owned one — the attach pool spans both", async () => {
    await setProjectAgentDefault(
      SCOPE,
      "conn-org",
      { access: "full", resources: null },
      "u1",
    );
    expect(store.defaults).toHaveLength(1);
    expect(store.defaults[0]!.connectionId).toBe("conn-org");
  });

  it("validates tool ids against the connection's catalog for custom access", async () => {
    await setProjectAgentDefault(
      SCOPE,
      "conn-project",
      {
        access: "custom",
        allow: ["t-read"],
        ask: ["t-write"],
        resources: null,
      },
      "u1",
    );
    expect(assertToolIdsValid).toHaveBeenCalledWith("github", [
      "t-read",
      "t-write",
    ]);
  });

  it("upsert: a second call on the same connection replaces, not duplicates", async () => {
    await setProjectAgentDefault(
      SCOPE,
      "conn-project",
      { access: "full", resources: null },
      "u1",
    );
    await setProjectAgentDefault(
      SCOPE,
      "conn-project",
      { access: "custom", allow: ["t-read"], ask: [], resources: null },
      "u1",
    );
    expect(store.defaults).toHaveLength(1);
    expect(store.defaults[0]!.access).toBe("custom");
  });
});

describe("removeProjectAgentDefault", () => {
  it("is a no-op when nothing matches", async () => {
    await expect(
      removeProjectAgentDefault(SCOPE, "conn-project"),
    ).resolves.toBeUndefined();
  });

  it("removes an existing default", async () => {
    await setProjectAgentDefault(
      SCOPE,
      "conn-project",
      { access: "full", resources: null },
      "u1",
    );
    await removeProjectAgentDefault(SCOPE, "conn-project");
    expect(store.defaults).toHaveLength(0);
  });
});

describe("applyProjectAgentDefaults — the create-time apply step", () => {
  it("calls setConnectionGrant once per default, with system attribution (userId null)", async () => {
    store.defaults = [
      {
        projectId: "proj-1",
        connectionId: "conn-project",
        access: "full",
        allow: [],
        ask: [],
        resources: null,
        createdByUserId: "u1",
      },
      {
        projectId: "proj-1",
        connectionId: "conn-org",
        access: "custom",
        allow: ["t-read"],
        ask: [],
        resources: null,
        createdByUserId: "u1",
      },
    ];

    await applyProjectAgentDefaults(SCOPE, "new-agent");

    expect(setConnectionGrant).toHaveBeenCalledTimes(2);
    expect(setConnectionGrant).toHaveBeenCalledWith(
      SCOPE,
      "new-agent",
      "conn-project",
      { access: "full", resources: null },
      null,
    );
    expect(setConnectionGrant).toHaveBeenCalledWith(
      SCOPE,
      "new-agent",
      "conn-org",
      { access: "custom", allow: ["t-read"], ask: [], resources: null },
      null,
    );
  });

  it("one connection's grant failing does not stop the rest — best-effort, never blocks agent creation", async () => {
    store.defaults = [
      {
        projectId: "proj-1",
        connectionId: "conn-project",
        access: "full",
        allow: [],
        ask: [],
        resources: null,
        createdByUserId: null,
      },
      {
        projectId: "proj-1",
        connectionId: "conn-org",
        access: "full",
        allow: [],
        ask: [],
        resources: null,
        createdByUserId: null,
      },
    ];
    setConnectionGrant.mockRejectedValueOnce(new Error("catalog drifted"));

    await expect(
      applyProjectAgentDefaults(SCOPE, "new-agent"),
    ).resolves.toBeUndefined();
    expect(setConnectionGrant).toHaveBeenCalledTimes(2);
  });

  it("no defaults configured: applies nothing, resolves cleanly", async () => {
    await applyProjectAgentDefaults(SCOPE, "new-agent");
    expect(setConnectionGrant).not.toHaveBeenCalled();
  });
});
