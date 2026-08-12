import { describe, expect, it } from "vitest";

import { maskSecret } from "./mask-secret";

const REAL_KEY = `oc_${"a1b2c3d4".repeat(8)}`; // oc_ + 64 hex chars

describe("maskSecret", () => {
  it("keeps 6 leading and 4 trailing characters, bullets the middle", () => {
    expect(maskSecret(REAL_KEY)).toBe(`oc_a1b${"•".repeat(12)}c3d4`);
  });

  it("never emits the raw key", () => {
    expect(maskSecret(REAL_KEY)).not.toContain(REAL_KEY);
    expect(maskSecret(REAL_KEY)).not.toMatch(/oc_[0-9a-f]{64}/);
  });

  it("masks the whole value when it is short enough to be guessable", () => {
    expect(maskSecret("oc_key")).toBe("••••••••");
    expect(maskSecret("0123456789")).toBe("••••••••");
    expect(maskSecret("")).toBe("••••••••");
  });

  it("starts revealing only past the short-value threshold", () => {
    expect(maskSecret("01234567890")).toBe(`012345${"•".repeat(12)}7890`);
  });

  it("is a fixed width regardless of secret length — no length leak", () => {
    expect(maskSecret(REAL_KEY)).toHaveLength(22);
    expect(maskSecret(`${REAL_KEY}${REAL_KEY}`)).toHaveLength(22);
  });
});
