import { z } from "zod";

import {
  compilesAsConditionRegex,
  isValidHeaderName,
} from "./condition-syntax";

export const policyModeSchema = z.enum(["allow", "deny"]);
export type PolicyMode = z.infer<typeof policyModeSchema>;

// A behavioral rule condition, evaluated by the gateway (`condition_match`):
// `body` matches the buffered request body, `header` matches the named request
// header (`key` = the header name, case-insensitive per RFC 9110; values are
// compared case-sensitively — `(?i)` regex for insensitive). `exists` is
// header-only; every other operator requires a `value`. A strict superset of
// the original `{target:"body", operator:"contains"}` shape, so stored rows
// keep validating. Regex compilation here (JS) is best-effort UX — the gateway
// compiles Rust `regex` syntax (no lookaround/backreferences) and treats an
// uncompilable pattern fail-closed (a Block rule over-blocks).
export const ruleConditionSchema = z
  .object({
    target: z.enum(["body", "header"]),
    operator: z.enum(["contains", "equals", "regex", "exists"]),
    value: z.string().max(1000).optional(),
    key: z.string().max(500).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.target === "header") {
      if (!c.key?.trim()) {
        ctx.addIssue({
          code: "custom",
          message: "header conditions require a header name (key)",
        });
      } else if (!isValidHeaderName(c.key)) {
        // Validate the RAW key against the RFC 9110 token charset the
        // gateway's `HeaderName::from_bytes` accepts — a key it rejects
        // (embedded/trailing space) would save fine but be permanently
        // unevaluable: a silent no-op Allow or an over-blocking Block.
        ctx.addIssue({ code: "custom", message: "invalid header name" });
      }
    }
    if (c.operator === "exists" && c.target !== "header") {
      ctx.addIssue({
        code: "custom",
        message: "exists applies to headers only",
      });
    }
    if (c.operator !== "exists" && !(c.value && c.value.length >= 1)) {
      ctx.addIssue({ code: "custom", message: "value is required" });
    }
    if (
      c.operator === "regex" &&
      c.value &&
      !compilesAsConditionRegex(c.value)
    ) {
      // Best-effort typo check only — the gateway compiles Rust `regex`
      // syntax and is the authoritative (fail-closed) backstop. The shared
      // helper normalizes Rust-only syntax before the JS compile; a false
      // accept is safe, a false reject would block valid gateway patterns.
      ctx.addIssue({ code: "custom", message: "invalid regular expression" });
    }
  });

export type RuleCondition = z.infer<typeof ruleConditionSchema>;

export const createPolicyRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    hostPattern: z.string().min(1).max(1000),
    pathPattern: z.string().max(1000).optional(),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
    action: z.enum(["block", "rate_limit", "manual_approval", "allow"]),
    enabled: z.boolean(),
    agentId: z.string().optional(),
    rateLimit: z.number().int().min(1).max(1_000_000).optional(),
    rateLimitWindow: z.enum(["minute", "hour", "day"]).optional(),
    conditions: z.array(ruleConditionSchema).max(10).optional(),
  })
  .refine(
    (data) => {
      if (data.action === "rate_limit") {
        return (
          data.rateLimit !== undefined && data.rateLimitWindow !== undefined
        );
      }
      return true;
    },
    {
      message:
        "rateLimit and rateLimitWindow are required when action is rate_limit",
    },
  );

export type CreatePolicyRuleInput = z.infer<typeof createPolicyRuleSchema>;

export const updatePolicyRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    hostPattern: z.string().min(1).max(1000).optional(),
    pathPattern: z.string().max(1000).nullable().optional(),
    method: z
      .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
      .nullable()
      .optional(),
    action: z
      .enum(["block", "rate_limit", "manual_approval", "allow"])
      .optional(),
    enabled: z.boolean().optional(),
    agentId: z.string().nullable().optional(),
    rateLimit: z.number().int().min(1).max(1_000_000).nullable().optional(),
    rateLimitWindow: z.enum(["minute", "hour", "day"]).nullable().optional(),
    conditions: z.array(ruleConditionSchema).max(10).nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export type UpdatePolicyRuleInput = z.infer<typeof updatePolicyRuleSchema>;
