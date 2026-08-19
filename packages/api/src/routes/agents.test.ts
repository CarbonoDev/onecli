import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /v1/agents's afterCreateAgent wiring: the project's default-connections
// template is applied right after the agent row commits, before the response
// goes out. The service's own laws live in
// agent-default-connections-service.test.ts; this only proves the route calls
// the hook with the right args, at the right point, and that a missing hook
// (the OSS-before-this-change / EE-not-yet-updated shape) doesn't break the route.

const ORG_KEY = "oc_org_test-key";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem-slim";
});

const services = vi.hoisted(() => ({
  listAgents: vi.fn(),
  createAgent: vi.fn(),
  agentExistsByIdentifier: vi.fn(),
  getDefaultAgent: vi.fn(),
  getAgentDetail: vi.fn(),
  setDefaultAgent: vi.fn(),
  renameAgent: vi.fn(),
  deleteAgent: vi.fn(),
  regenerateAgentToken: vi.fn(),
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === ORG_KEY
          ? { userId: "user-1", organizationId: "org-1", scope: "organization" }
          : null,
      findFirst: async () => null,
    },
    user: { findUnique: async () => ({ email: "admin@example.com" }) },
    organizationMember: {
      findUnique: async () => ({
        organizationId: "org-1",
        userId: "user-1",
        role: "owner",
      }),
    },
    project: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        where.id === "p1" ? { id: "p1" } : null,
    },
    auditLog: { create: async () => ({}) },
  },
}));

vi.mock("../services/agent-service", () => ({
  listAgents: services.listAgents,
  createAgent: services.createAgent,
  agentExistsByIdentifier: services.agentExistsByIdentifier,
  getDefaultAgent: services.getDefaultAgent,
  getAgentDetail: services.getAgentDetail,
  setDefaultAgent: services.setDefaultAgent,
  renameAgent: services.renameAgent,
  deleteAgent: services.deleteAgent,
  regenerateAgentToken: services.regenerateAgentToken,
}));

vi.mock("../services/grants-summary-service", () => ({
  listAgentsWithGrantsSummary: vi.fn(),
}));

const { createApiApp } = await import("../app");
const { ServiceError } = await import("../services/errors");

const AUTH = {
  authorization: `Bearer ${ORG_KEY}`,
  "x-project-id": "p1",
  "content-type": "application/json",
};
const NEW_AGENT = {
  id: "new-agent-id",
  name: "Scout",
  identifier: "scout",
  createdAt: new Date(0),
};

beforeEach(() => {
  for (const fn of Object.values(services)) fn.mockReset();
  services.agentExistsByIdentifier.mockResolvedValue(false);
  services.createAgent.mockResolvedValue(NEW_AGENT);
});

describe("POST /v1/agents — afterCreateAgent hook wiring", () => {
  it("calls afterCreateAgent with (organizationId, projectId, new agent id) after the agent is created", async () => {
    const afterCreateAgent = vi.fn(async () => {});
    const app = createApiApp(
      { getSession: async () => null },
      {
        resourceHooks: {
          beforeCreateAgent: async () => {},
          beforeCreateSecret: async () => {},
          afterCreateAgent,
        },
      },
    );

    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ name: "Scout", identifier: "scout" }),
    });

    expect(res.status).toBe(201);
    expect(afterCreateAgent).toHaveBeenCalledWith(
      "org-1",
      "p1",
      "new-agent-id",
    );
  });

  it("an edition with no afterCreateAgent (optional hook) still creates the agent fine", async () => {
    const app = createApiApp(
      { getSession: async () => null },
      {
        resourceHooks: {
          beforeCreateAgent: async () => {},
          beforeCreateSecret: async () => {},
          // afterCreateAgent intentionally omitted
        },
      },
    );

    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ name: "Scout", identifier: "scout" }),
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      ...NEW_AGENT,
      createdAt: NEW_AGENT.createdAt.toISOString(),
    });
  });

  it("does not call afterCreateAgent when creation is skipped (existing identifier → agentExistsByIdentifier true still runs createAgent, which 409s)", async () => {
    services.agentExistsByIdentifier.mockResolvedValue(true);
    services.createAgent.mockRejectedValue(
      new ServiceError(
        "CONFLICT",
        "An agent with this identifier already exists",
      ),
    );
    const afterCreateAgent = vi.fn(async () => {});
    const app = createApiApp(
      { getSession: async () => null },
      {
        resourceHooks: {
          beforeCreateAgent: async () => {},
          beforeCreateSecret: async () => {},
          afterCreateAgent,
        },
      },
    );

    await app.request("/v1/agents", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ name: "Scout", identifier: "scout" }),
    });

    expect(afterCreateAgent).not.toHaveBeenCalled();
  });
});
