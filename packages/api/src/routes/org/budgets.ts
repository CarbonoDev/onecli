import { Hono } from "hono";
import { z } from "zod";
import type { ApiEnv } from "../../types";
import type { AuthContext } from "../../providers";
import { auth } from "../../middleware/auth";
import { ServiceError } from "../../services/errors";
import {
  listBudgets,
  createBudget,
  updateBudget,
  deleteBudget,
} from "../../services/budget-service";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../../services/audit-service";

/**
 * `/v1/org/budgets` — per-(secret, org) spend caps.
 *
 * Same guard stack as `/v1/org/policy` (see `policy.ts`): admin-only, and an
 * org-scope-credential guard on top. Budgets are ORG guardrails — a project-
 * scoped agent key (even one whose user is an org admin) must not edit the cap
 * its own traffic is metered against. Org authority requires an org credential.
 *
 * `withAudit` keys `invalidateGatewayCacheForOrg` off `organizationId`, so a
 * new/changed cap takes effect within the connect cache TTL.
 */

const periodSchema = z.enum(["monthly", "total"]);

const createBudgetSchema = z.object({
  secretId: z.string().min(1),
  limitCents: z.number().int().positive(),
  period: periodSchema.default("monthly"),
});

const updateBudgetSchema = z
  .object({
    limitCents: z.number().int().positive().optional(),
    period: periodSchema.optional(),
  })
  .refine((v) => v.limitCents !== undefined || v.period !== undefined, {
    message: "Provide limitCents and/or period.",
  });

const parse = <S extends z.ZodTypeAny>(
  schema: S,
  body: unknown,
): z.infer<S> => {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ServiceError(
      "UNPROCESSABLE",
      result.error.issues[0]?.message ?? "Invalid request body",
    );
  }
  return result.data;
};

const jsonBody = (c: { req: { json: () => Promise<unknown> } }) =>
  c.req.json().catch(() => null);

export const ossOrgBudgetRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", auth({ requireProject: false, role: "admin" }));
  app.use("*", async (c, next) => {
    if (c.get("auth").scope === "project") {
      throw new ServiceError(
        "FORBIDDEN",
        "Organization budgets require an organization-scoped credential.",
      );
    }
    return next();
  });

  const auditBase = (a: AuthContext) => ({
    organizationId: a.organizationId,
    userId: a.userId,
    userEmail: a.userEmail,
    service: AUDIT_SERVICES.BUDGET,
    source: AUDIT_SOURCE.API,
  });

  app.get("/", async (c) => {
    const { organizationId } = c.get("auth");
    return c.json(await listBudgets(organizationId));
  });

  app.post("/", async (c) => {
    const auth = c.get("auth");
    const input = parse(createBudgetSchema, await jsonBody(c));
    const budget = await withAudit(
      () => createBudget(auth.organizationId, input, auth.userId),
      (b) => ({
        ...auditBase(auth),
        action: AUDIT_ACTIONS.CREATE,
        metadata: {
          budgetId: b.id,
          secretId: b.secretId,
          limitCents: b.limitCents,
          period: b.period,
        },
      }),
    );
    return c.json(budget, 201);
  });

  app.patch("/:id", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    const input = parse(updateBudgetSchema, await jsonBody(c));
    const budget = await withAudit(
      () => updateBudget(auth.organizationId, id, input),
      (b) => ({
        ...auditBase(auth),
        action: AUDIT_ACTIONS.UPDATE,
        metadata: {
          budgetId: id,
          secretId: b.secretId,
          limitCents: b.limitCents,
          period: b.period,
        },
      }),
    );
    return c.json(budget);
  });

  app.delete("/:id", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    await withAudit(
      () => deleteBudget(auth.organizationId, id),
      (r) => ({
        ...auditBase(auth),
        action: AUDIT_ACTIONS.DELETE,
        metadata: { budgetId: id, secretId: r.secretId },
      }),
    );
    return c.body(null, 204);
  });

  return app;
};
