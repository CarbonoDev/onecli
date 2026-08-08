import { Suspense } from "react";
import { BudgetsContent } from "./_components/budgets-content";

export default function ConnectionsBudgetsPage() {
  return (
    <Suspense>
      <BudgetsContent />
    </Suspense>
  );
}
