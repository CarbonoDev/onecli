"use client";

import { X } from "lucide-react";
import type { RuleCondition } from "@onecli/api/validations/policy-rule";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import { conditionError } from "./validate";

const TARGET_OPTIONS: { value: RuleCondition["target"]; label: string }[] = [
  { value: "body", label: "Request body" },
  { value: "header", label: "Header" },
];

const OPERATOR_OPTIONS: {
  value: RuleCondition["operator"];
  label: string;
  headerOnly?: boolean;
}[] = [
  { value: "contains", label: "contains" },
  { value: "equals", label: "equals" },
  { value: "regex", label: "matches regex" },
  // `exists` is header-only ("has a body" is not a meaningful policy).
  { value: "exists", label: "is present", headerOnly: true },
];

export interface ConditionRowProps {
  condition: RuleCondition;
  onChange: (condition: RuleCondition) => void;
  onRemove: () => void;
}

export const ConditionRow = ({
  condition,
  onChange,
  onRemove,
}: ConditionRowProps) => {
  const isHeader = condition.target === "header";
  const needsValue = condition.operator !== "exists";
  const error = conditionError(condition);

  const setTarget = (target: RuleCondition["target"]) => {
    onChange({
      target,
      // `exists` doesn't apply to bodies; `key` is the header name.
      operator:
        target === "body" && condition.operator === "exists"
          ? "contains"
          : condition.operator,
      value: condition.value,
      key: target === "header" ? condition.key : undefined,
    });
  };

  const setOperator = (operator: RuleCondition["operator"]) => {
    onChange({
      ...condition,
      operator,
      value: operator === "exists" ? undefined : condition.value,
    });
  };

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={condition.target}
          onValueChange={(v) => setTarget(v as RuleCondition["target"])}
        >
          <SelectTrigger
            size="sm"
            className="w-[8.5rem] shrink-0"
            aria-label="Condition target"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TARGET_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {isHeader && (
          <Input
            value={condition.key ?? ""}
            onChange={(e) => onChange({ ...condition, key: e.target.value })}
            placeholder="x-header-name"
            maxLength={500}
            className="h-8 w-36 font-mono text-xs"
            aria-label="Header name"
          />
        )}
        <Select
          value={condition.operator}
          onValueChange={(v) => setOperator(v as RuleCondition["operator"])}
        >
          <SelectTrigger
            size="sm"
            className="w-[8.5rem] shrink-0"
            aria-label="Condition operator"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OPERATOR_OPTIONS.filter((opt) => isHeader || !opt.headerOnly).map(
              (opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ),
            )}
          </SelectContent>
        </Select>
        {needsValue && (
          <Input
            value={condition.value ?? ""}
            onChange={(e) => onChange({ ...condition, value: e.target.value })}
            placeholder={
              condition.operator === "regex" ? "(?i)delete\\s+repo" : "text…"
            }
            maxLength={1000}
            className="h-8 min-w-32 flex-1 font-mono text-xs"
            aria-label="Condition value"
          />
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          onClick={onRemove}
          aria-label="Remove condition"
        >
          <X className="size-3.5" />
        </Button>
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
};
