import { Hono } from "hono";
import type { ApiEnv } from "../types";
import type { AuthContext } from "../providers";
import { authMiddleware, requireProjectId } from "../middleware/auth";
import { ServiceError } from "../services/errors";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../services/audit-service";
import { connectionGrantSchema } from "../validations/grants";
import {
  listProjectAgentDefaults,
  removeProjectAgentDefault,
  setProjectAgentDefault,
} from "../services/agent-default-connections-service";
import type { GrantScope } from "../services/grants-service";

// The project-level "which connections should a brand-new agent start with"
// template (plans/agent-default-connections.md). Read by `afterCreateAgent`
// at agent-creation time; this router is the CRUD surface a human (or the
// settings UI) uses to configure it. Mirrors routes/grants.ts's shape one
// level up: project scope instead of agent scope, connections only (no
// secrets arm yet — the ask that motivated this was credential connections).

const scopeOf = (auth: AuthContext): GrantScope => ({
  projectId: requireProjectId(auth),
  organizationId: auth.organizationId,
});

const auditBase = (auth: AuthContext) => ({
  projectId: requireProjectId(auth),
  userId: auth.userId,
  userEmail: auth.userEmail,
  service: AUDIT_SERVICES.GRANT,
  source: AUDIT_SOURCE.API,
});

export const agentDefaultsRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  // GET /agent-defaults — the project's current template (read-only, no audit).
  app.get("/", async (c) => {
    const auth = c.get("auth");
    return c.json(await listProjectAgentDefaults(scopeOf(auth)));
  });

  // PUT /agent-defaults/connections/:connectionId — set or replace.
  app.put("/connections/:connectionId", async (c) => {
    const auth = c.get("auth");
    const connectionId = c.req.param("connectionId");
    const body = await c.req.json().catch(() => null);
    const parsed = connectionGrantSchema.safeParse(body);
    if (!parsed.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        parsed.error.issues[0]?.message ?? "Invalid default body",
      );
    }
    await withAudit(
      () =>
        setProjectAgentDefault(
          scopeOf(auth),
          connectionId,
          parsed.data,
          auth.userId,
        ),
      () => ({
        ...auditBase(auth),
        action: AUDIT_ACTIONS.UPDATE,
        metadata: {
          connectionId,
          access: parsed.data.access,
          target: "agent-default",
        },
      }),
    );
    return c.json(await listProjectAgentDefaults(scopeOf(auth)));
  });

  // DELETE /agent-defaults/connections/:connectionId — remove from the template.
  app.delete("/connections/:connectionId", async (c) => {
    const auth = c.get("auth");
    const connectionId = c.req.param("connectionId");
    await withAudit(
      () => removeProjectAgentDefault(scopeOf(auth), connectionId),
      () => ({
        ...auditBase(auth),
        action: AUDIT_ACTIONS.DELETE,
        metadata: { connectionId, target: "agent-default" },
      }),
    );
    return c.body(null, 204);
  });

  return app;
};
