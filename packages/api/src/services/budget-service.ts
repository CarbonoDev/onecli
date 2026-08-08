import { db, Prisma } from "@onecli/db";
import { ServiceError } from "./errors";

// Per-(secret, org) spend caps. Every call is fenced to ONE organization — the
// caller's `auth.organizationId`, never a body parameter — so this can neither
// read nor write another org's budgets. A budget is a cost guardrail the gateway
// enforces (see `apps/gateway/src/budget.rs`); this service is the CRUD surface.
//
// 4a scope: a budget binds to an ORG-scoped LLM secret the org owns
// (`type ∈ {anthropic, openai}`) — the metered providers the gateway can price.
// Project-scoped binding is DESCOPED (the `projectId` column is reserved).

/** LLM secret types the gateway meters (must match `budget.rs::is_metered_type`). */
const METERED_TYPES = ["anthropic", "openai"] as const;

/** 1 cent = 1e7 nano-dollars (must match `budget.rs::CENT_TO_NANOS`). */
const CENT_TO_NANOS = 10_000_000n;

export interface BudgetListRow {
  id: string;
  secretId: string;
  secretName: string;
  secretType: string;
  limitCents: number;
  period: string;
  /** Accumulated spend this period, floored to whole cents (from `BudgetSpend`). */
  spentCents: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBudgetInput {
  secretId: string;
  limitCents: number;
  period: "monthly" | "total";
}

export interface UpdateBudgetInput {
  limitCents?: number;
  period?: "monthly" | "total";
}

/** Current monthly window key (UTC) — must match `budget.rs::period_key`. */
const monthlyPeriodKey = (now = new Date()): string => {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `m:${year}-${month}`;
};

const nanosToCents = (nanos: bigint): number => Number(nanos / CENT_TO_NANOS);

/**
 * Current-period accumulated spend for one budget, in whole cents. Reads the
 * `BudgetSpend` window key the period selects (monthly → `m:YYYY-MM`, total →
 * `total`), matching `listBudgets`. Returns 0 when nothing has been metered yet.
 */
const currentSpentCents = async (
  organizationId: string,
  secretId: string,
  period: string,
): Promise<number> => {
  const key = period === "total" ? "total" : monthlyPeriodKey();
  const spend = await db.budgetSpend.findFirst({
    where: { organizationId, secretId, period: key },
    select: { spentNanos: true },
  });
  return spend ? nanosToCents(spend.spentNanos) : 0;
};

/**
 * List the org's budgets, each joined with its current-period accumulated spend
 * (`BudgetSpend.spentNanos`) for the usage display. A budget's period selects
 * which spend window key it reads: monthly → `m:YYYY-MM`, total → `total`.
 */
export const listBudgets = async (
  organizationId: string,
): Promise<BudgetListRow[]> => {
  const budgets = await db.budget.findMany({
    where: { organizationId },
    include: { secret: { select: { name: true, type: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (budgets.length === 0) return [];

  const monthly = monthlyPeriodKey();
  const spends = await db.budgetSpend.findMany({
    where: {
      organizationId,
      secretId: { in: budgets.map((b) => b.secretId) },
      period: { in: [monthly, "total"] },
    },
  });
  const spentBy = new Map<string, bigint>();
  for (const s of spends) {
    spentBy.set(`${s.secretId}:${s.period}`, s.spentNanos);
  }

  return budgets.map((b) => {
    const key = `${b.secretId}:${b.period === "total" ? "total" : monthly}`;
    const spentNanos = spentBy.get(key) ?? 0n;
    return {
      id: b.id,
      secretId: b.secretId,
      secretName: b.secret.name,
      secretType: b.secret.type,
      limitCents: b.limitCents,
      period: b.period,
      spentCents: nanosToCents(spentNanos),
      createdAt: b.createdAt.toISOString(),
      updatedAt: b.updatedAt.toISOString(),
    };
  });
};

/**
 * Create a budget on an org-owned metered LLM secret. Rejects a secret that is
 * not the org's (404) or not a meterable type (400 — a budget on an unmeterable
 * secret is a silent no-op). A duplicate `(secretId, org)` is a 409.
 */
export const createBudget = async (
  organizationId: string,
  input: CreateBudgetInput,
  createdBy: string,
): Promise<BudgetListRow> => {
  const secret = await db.secret.findUnique({
    where: { id: input.secretId },
    select: { id: true, name: true, type: true, organizationId: true },
  });
  if (!secret || secret.organizationId !== organizationId) {
    throw new ServiceError(
      "NOT_FOUND",
      "Secret not found in this organization.",
    );
  }
  if (!(METERED_TYPES as readonly string[]).includes(secret.type)) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Budgets are only supported on Anthropic or OpenAI secrets.",
    );
  }

  try {
    const created = await db.budget.create({
      data: {
        secretId: input.secretId,
        organizationId,
        limitCents: input.limitCents,
        period: input.period,
        createdBy,
      },
    });
    return {
      id: created.id,
      secretId: created.secretId,
      secretName: secret.name,
      secretType: secret.type,
      limitCents: created.limitCents,
      period: created.period,
      spentCents: 0,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    };
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ServiceError(
        "CONFLICT",
        "A budget already exists for this secret.",
      );
    }
    throw err;
  }
};

/** Load a budget fenced to the org, or throw 404. */
const requireOrgBudget = async (organizationId: string, id: string) => {
  const budget = await db.budget.findFirst({
    where: { id, organizationId },
    include: { secret: { select: { name: true, type: true } } },
  });
  if (!budget) {
    throw new ServiceError("NOT_FOUND", "Budget not found.");
  }
  return budget;
};

/** Update a budget's cap and/or period (org-fenced). */
export const updateBudget = async (
  organizationId: string,
  id: string,
  input: UpdateBudgetInput,
): Promise<BudgetListRow> => {
  await requireOrgBudget(organizationId, id);
  const updated = await db.budget.update({
    where: { id },
    data: {
      ...(input.limitCents !== undefined
        ? { limitCents: input.limitCents }
        : {}),
      ...(input.period !== undefined ? { period: input.period } : {}),
    },
    include: { secret: { select: { name: true, type: true } } },
  });
  // Report real current-period spend (a budget may already have accumulated it)
  // rather than a placeholder 0, so the PATCH response matches `listBudgets`.
  const spentCents = await currentSpentCents(
    organizationId,
    updated.secretId,
    updated.period,
  );
  return {
    id: updated.id,
    secretId: updated.secretId,
    secretName: updated.secret.name,
    secretType: updated.secret.type,
    limitCents: updated.limitCents,
    period: updated.period,
    spentCents,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
  };
};

/** Delete a budget (org-fenced). Returns the removed budget's id + secret. */
export const deleteBudget = async (
  organizationId: string,
  id: string,
): Promise<{ id: string; secretId: string }> => {
  const budget = await requireOrgBudget(organizationId, id);
  await db.budget.delete({ where: { id } });
  return { id: budget.id, secretId: budget.secretId };
};
