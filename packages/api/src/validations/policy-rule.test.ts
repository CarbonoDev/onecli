import { describe, expect, it } from "vitest";

import { ruleConditionSchema } from "./policy-rule";

describe("ruleConditionSchema — body/header behavioral conditions", () => {
  it("still parses the legacy body/contains row (stored-data compatibility)", () => {
    expect(
      ruleConditionSchema.parse({
        target: "body",
        operator: "contains",
        value: "delete repo",
      }),
    ).toEqual({ target: "body", operator: "contains", value: "delete repo" });
    // `key` was reserved from day one — accepted (and ignored) on body rows.
    expect(
      ruleConditionSchema.safeParse({
        target: "body",
        operator: "contains",
        value: "x",
        key: "ignored",
      }).success,
    ).toBe(true);
  });

  it("accepts body equals/regex conditions", () => {
    expect(
      ruleConditionSchema.safeParse({
        target: "body",
        operator: "equals",
        value: "exact",
      }).success,
    ).toBe(true);
    // Rust inline flag groups (`(?i)`) are gateway-valid — the JS best-effort
    // check must not reject them (it strips them before compiling).
    expect(
      ruleConditionSchema.safeParse({
        target: "body",
        operator: "regex",
        value: "(?i)delete\\s+repo",
      }).success,
    ).toBe(true);
    // Scoped flag groups (`(?i:…)`) and named groups (`(?P<n>…)`) are also
    // gateway-valid Rust syntax JS lacks — normalized, never falsely rejected.
    expect(
      ruleConditionSchema.safeParse({
        target: "body",
        operator: "regex",
        value: "(?i:delete) repo",
      }).success,
    ).toBe(true);
    expect(
      ruleConditionSchema.safeParse({
        target: "body",
        operator: "regex",
        value: "(?P<verb>delete|remove) repo",
      }).success,
    ).toBe(true);
  });

  it("accepts header conditions with a key", () => {
    expect(
      ruleConditionSchema.safeParse({
        target: "header",
        operator: "equals",
        key: "x-goog-user-project",
        value: "prod",
      }).success,
    ).toBe(true);
  });

  it("rejects a header condition without a key", () => {
    expect(
      ruleConditionSchema.safeParse({
        target: "header",
        operator: "equals",
        value: "prod",
      }).success,
    ).toBe(false);
    // Whitespace-only keys count as missing.
    expect(
      ruleConditionSchema.safeParse({
        target: "header",
        operator: "equals",
        key: "  ",
        value: "prod",
      }).success,
    ).toBe(false);
  });

  it("rejects header names outside the RFC 9110 token charset", () => {
    // The gateway's `HeaderName::from_bytes` rejects these — saving them
    // would create a permanently unevaluable condition (silent no-op Allow /
    // over-blocking Block), so the API must refuse them up front.
    for (const key of ["x-foo ", " x-foo", "X Foo", "x:foo", "héader"]) {
      expect(
        ruleConditionSchema.safeParse({
          target: "header",
          operator: "equals",
          key,
          value: "v",
        }).success,
      ).toBe(false);
    }
    // The full token charset is accepted.
    expect(
      ruleConditionSchema.safeParse({
        target: "header",
        operator: "exists",
        key: "x-api_key.v2~test",
      }).success,
    ).toBe(true);
  });

  it("accepts exists on a header without a value, rejects it on body", () => {
    expect(
      ruleConditionSchema.safeParse({
        target: "header",
        operator: "exists",
        key: "x-api-key",
      }).success,
    ).toBe(true);
    expect(
      ruleConditionSchema.safeParse({ target: "body", operator: "exists" })
        .success,
    ).toBe(false);
  });

  it("rejects a missing/empty value for the value-bearing operators", () => {
    for (const operator of ["contains", "equals", "regex"] as const) {
      expect(
        ruleConditionSchema.safeParse({ target: "body", operator }).success,
      ).toBe(false);
      expect(
        ruleConditionSchema.safeParse({ target: "body", operator, value: "" })
          .success,
      ).toBe(false);
    }
  });

  it("rejects a regex that does not compile (best-effort UX check)", () => {
    expect(
      ruleConditionSchema.safeParse({
        target: "body",
        operator: "regex",
        value: "([unclosed",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown targets and operators", () => {
    expect(
      ruleConditionSchema.safeParse({
        target: "cookies",
        operator: "contains",
        value: "x",
      }).success,
    ).toBe(false);
    expect(
      ruleConditionSchema.safeParse({
        target: "body",
        operator: "telepathy",
        value: "x",
      }).success,
    ).toBe(false);
  });
});
