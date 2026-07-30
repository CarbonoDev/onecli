"use client";

import { Plus } from "lucide-react";
import type { RuleCondition } from "@onecli/api/validations/policy-rule";
import { Button } from "@onecli/ui/components/button";
import { ConditionRow } from "./condition-row";

/** Mirrors the API's `z.array(ruleConditionSchema).max(10)` cap. */
const MAX_CONDITIONS = 10;

export interface ConditionBuilderProps {
  conditions: RuleCondition[];
  onChange: (conditions: RuleCondition[]) => void;
}

/**
 * Build the behavioral conditions (body/header matching) that narrow when a
 * rule applies. The gateway evaluates them per request: ALL conditions must
 * match for the rule to apply. Body matching runs over the buffered request
 * body (up to 256 KB); a body over 256 KB can't be evaluated — Block rules
 * treat it as matching (fail-closed), other rules don't apply. Header names
 * are case-insensitive, header values case-sensitive (use a `(?i)` regex for
 * case-insensitive values). Regex uses Rust syntax — no lookaround or
 * backreferences.
 */
export const ConditionBuilder = ({
  conditions,
  onChange,
}: ConditionBuilderProps) => {
  const update = (index: number, condition: RuleCondition) =>
    onChange(conditions.map((c, i) => (i === index ? condition : c)));
  const remove = (index: number) =>
    onChange(conditions.filter((_, i) => i !== index));
  const add = () =>
    onChange([...conditions, { target: "body", operator: "contains" }]);

  return (
    <div className="space-y-2">
      {conditions.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          No conditions — the rule applies to every matching request. Add a
          condition to also match on request body content or headers.
        </p>
      ) : (
        <div className="space-y-2">
          {conditions.map((condition, index) => (
            <ConditionRow
              // Index keys are fine: rows are only appended/removed in place
              // and carry no internal state beyond the controlled inputs.
              key={index}
              condition={condition}
              onChange={(c) => update(index, c)}
              onRemove={() => remove(index)}
            />
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={add}
          disabled={conditions.length >= MAX_CONDITIONS}
        >
          <Plus className="size-3.5" />
          Add condition
        </Button>
        {conditions.length > 1 && (
          <p className="text-muted-foreground text-xs">
            All conditions must match.
          </p>
        )}
      </div>
      {conditions.length > 0 && (
        <p className="text-muted-foreground text-xs">
          Bodies over 256 KB can&apos;t be evaluated: Block rules treat them as
          matching; other rules don&apos;t apply. Header values are
          case-sensitive — use a <code className="font-mono">(?i)</code> regex
          for case-insensitive matching. Regex uses Rust syntax (no lookaround
          or backreferences).
        </p>
      )}
    </div>
  );
};
