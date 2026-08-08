import type { RuleCondition } from "@onecli/api/validations/policy-rule";
import {
  compilesAsConditionRegex,
  isValidHeaderName,
} from "@onecli/api/validations/condition-syntax";

/** The row's inline validation message, mirroring the API's rules (the syntax
 * checks are the SAME shared helpers, so the two can't drift) — so a 422 is
 * never the first feedback. `null` = valid. */
export const conditionError = (condition: RuleCondition): string | null => {
  if (condition.target === "header") {
    if (!condition.key?.trim()) {
      return "Header name is required.";
    }
    // The gateway accepts RFC 9110 token names only — anything else (a
    // copy-pasted trailing space, an embedded space) would save but be
    // permanently unevaluable.
    if (!isValidHeaderName(condition.key)) {
      return "Invalid header name.";
    }
  }
  if (condition.operator !== "exists" && !condition.value) {
    return "Value is required.";
  }
  if (
    condition.operator === "regex" &&
    condition.value &&
    !compilesAsConditionRegex(condition.value)
  ) {
    return "Invalid regular expression.";
  }
  return null;
};

/** Whether every condition would pass API validation — for consumers that want
 * to gate submit (the API still backstops). */
export const isConditionsValid = (conditions: RuleCondition[]): boolean =>
  conditions.every((condition) => conditionError(condition) === null);
