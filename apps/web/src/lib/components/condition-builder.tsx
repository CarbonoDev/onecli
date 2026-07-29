"use client";

import type { RuleCondition } from "@onecli/api/validations/policy-rule";

export interface ConditionBuilderProps {
  conditions: RuleCondition[];
  onChange: (conditions: RuleCondition[]) => void;
}

export const ConditionBuilder = ({}: ConditionBuilderProps) => (
  <div className="rounded-md border border-dashed px-3 py-2.5">
    <p className="text-xs text-muted-foreground">
      Match conditions (body content, headers) are not yet available in this
      build.
    </p>
  </div>
);
