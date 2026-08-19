import { beforeEach, describe, expect, it, vi } from "vitest";

// The agent-defaults routes' HTTP contract: auth, param/body validation,
// status codes, and the service-call wiring — mirrors grants.test.ts's shape
// one level up (project scope instead of agent scope). The service's own laws
// (pool fencing, tool-id validation, upsert semantics) live in
// agent-default-connections-service.test.ts.

const ORG_KEY = "oc_org_test-key";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem-slim";
});

const services = vi.hoisted(() => ({
  listProjectAgentDefaults: vi.fn(),
  setProjectAgentDefault: vi.fn(),
  removeProjectAgentDefault: vi.fn(),
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

vi.mock("../services/agent-default-connections-service", () => ({
  listProjectAgentDefaults: services.listProjectAgentDefaults,
  setProjectAgentDefault: services.setProjectAgentDefault,
  removeProjectAgentDefault: services.removeProjectAgentDefault,
}));

const { createApiApp } = await import("../app");

const app = createApiApp({ getSession: async () => null });

const AUTH = {
  authorization: `Bearer ${ORG_KEY}`,
  "x-project-id": "p1",
};
const SCOPE = { projectId: "p1", organizationId: "org-1" };
const TEMPLATE = [
  {
    connectionId: "c1",
    provider: "github",
    label: "GitHub",
    scope: "project" as const,
    access: "full" as const,
    allow: [],
    ask: [],
    resources: null,
  },
];

beforeEach(() => {
  for (const fn of Object.values(services)) fn.mockReset();
  services.listProjectAgentDefaults.mockResolvedValue(TEMPLATE);
  services.setProjectAgentDefault.mockResolvedValue(undefined);
  services.removeProjectAgentDefault.mockResolvedValue(undefined);
});

describe("agent-defaults routes", () => {
  it("requires auth", async () => {
    const res = await app.request("/v1/agent-defaults");
    expect(res.status).toBe(401);
  });

  it("GET returns the project's template", async () => {
    const res = await app.request("/v1/agent-defaults", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(TEMPLATE);
    expect(services.listProjectAgentDefaults).toHaveBeenCalledWith(SCOPE);
  });

  it("PUT rejects a malformed body with 422 and the standard error shape", async () => {
    const res = await app.request("/v1/agent-defaults/connections/c1", {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ access: "custom", allow: [], ask: [] }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("detach instead");
    expect(services.setProjectAgentDefault).not.toHaveBeenCalled();
  });

  it("PUT sets the default and returns the refreshed template", async () => {
    const res = await app.request("/v1/agent-defaults/connections/c1", {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ access: "full" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(TEMPLATE);
    expect(services.setProjectAgentDefault).toHaveBeenCalledWith(
      SCOPE,
      "c1",
      { access: "full" },
      "user-1",
    );
    // Re-reads after the write so the response always reflects what was
    // actually persisted, not an echo of the request body.
    expect(services.listProjectAgentDefaults).toHaveBeenCalledWith(SCOPE);
  });

  it("DELETE removes the default with 204", async () => {
    const res = await app.request("/v1/agent-defaults/connections/c1", {
      method: "DELETE",
      headers: AUTH,
    });
    expect(res.status).toBe(204);
    expect(services.removeProjectAgentDefault).toHaveBeenCalledWith(
      SCOPE,
      "c1",
    );
  });
});
