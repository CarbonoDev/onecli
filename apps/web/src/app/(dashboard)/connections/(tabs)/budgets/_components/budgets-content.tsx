"use client";

import { ApiError } from "@/lib/api";
import { useBudgets } from "@/hooks/use-budgets";
import { BudgetsList } from "./budgets-list";
import { CreateBudgetDialog } from "./create-budget-dialog";

export const BudgetsContent = () => {
  const { data: budgets = [], isLoading, error } = useBudgets();

  // Budgets are org guardrails: only admins with an org credential may manage
  // them. A 403 is expected for members — render an admin-only notice.
  if (error instanceof ApiError && error.status === 403) {
    return (
      <p className="text-sm text-muted-foreground">
        Spend budgets are managed by organization admins.
      </p>
    );
  }

  // Any other failure (500, network) is a real error — surface it rather than
  // falling through to the empty `budgets = []` state, which would present a
  // transport failure as "No budgets yet."
  if (error) {
    return (
      <p className="text-sm text-destructive">
        Failed to load spend budgets. Please try again.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Spend budgets</h2>
          <p className="text-sm text-muted-foreground">
            Cap LLM spend per secret. The gateway meters token usage and blocks
            new requests once a cap is reached.
          </p>
        </div>
        <CreateBudgetDialog existing={budgets} />
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading budgets…</p>
      ) : budgets.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No budgets yet. Create one to cap spend on an Anthropic or OpenAI
          secret.
        </p>
      ) : (
        <BudgetsList budgets={budgets} />
      )}
    </div>
  );
};
