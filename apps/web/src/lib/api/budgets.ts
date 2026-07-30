import { apiGet, apiPost, apiPatch, apiDelete } from "./client";

// Spend budgets are ORG guardrails: always `/v1/org/budgets` (admin-gated,
// requireProject: false). A budget caps spend on a metered LLM secret the org
// owns; the gateway enforces it (see apps/gateway/src/budget.rs).

export type BudgetPeriod = "monthly" | "total";

export interface Budget {
  id: string;
  secretId: string;
  secretName: string;
  secretType: string;
  limitCents: number;
  period: BudgetPeriod;
  /** Accumulated spend this period, floored to whole cents. */
  spentCents: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBudgetInput {
  secretId: string;
  limitCents: number;
  period?: BudgetPeriod;
}

export interface UpdateBudgetInput {
  limitCents?: number;
  period?: BudgetPeriod;
}

const base = "/v1/org/budgets";

export const list = () => apiGet<Budget[]>(base);

export const create = (input: CreateBudgetInput) =>
  apiPost<Budget>(base, input);

export const update = (id: string, input: UpdateBudgetInput) =>
  apiPatch<Budget>(`${base}/${id}`, input);

export const remove = (id: string) => apiDelete(`${base}/${id}`);
