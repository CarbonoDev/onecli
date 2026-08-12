import { beforeEach, describe, expect, it, vi } from "vitest";

// The throttle in isolation. `recordApiKeyUse` is the ONE place a successful
// authentication is allowed to write, so what matters here is how rarely it
// writes and how loudly it fails: never, and not at all.

interface UpdateManyArg {
  where: {
    id: string;
    OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: Date } }];
  };
  data: { lastUsedAt: Date };
}

const updateMany = vi.hoisted(() =>
  vi.fn(async (args: UpdateManyArg) => ({ count: args.where.id ? 1 : 0 })),
);

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: { apiKey: { updateMany } },
}));

const { recordApiKeyUse, API_KEY_LAST_USED_THROTTLE_MS } =
  await import("./api-key-service");

const NOW = Date.parse("2026-08-12T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms);

const lastCall = () => updateMany.mock.calls.at(-1)?.[0];

// Block body on purpose: an arrow that RETURNS the mock hands vitest a
// function it takes for a teardown callback and duly invokes with no args.
beforeEach(() => {
  updateMany.mockClear();
});

describe("recordApiKeyUse", () => {
  it("writes for a key that has never been used", async () => {
    const wrote = await recordApiKeyUse({ id: "key-1", lastUsedAt: null }, NOW);

    expect(wrote).toBe(true);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(lastCall()?.where.id).toBe("key-1");
    expect(lastCall()?.data.lastUsedAt.getTime()).toBe(NOW);
  });

  it("writes once the stored value has aged past the throttle", async () => {
    const wrote = await recordApiKeyUse(
      { id: "key-1", lastUsedAt: ago(API_KEY_LAST_USED_THROTTLE_MS + 1000) },
      NOW,
    );

    expect(wrote).toBe(true);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  // The trap this whole design exists to avoid: a write on every authenticated
  // request. Inside the window the call must touch the database ZERO times —
  // not write a no-op row, not issue a statement at all.
  it("THROTTLES: touches nothing while the stored value is still fresh", async () => {
    const fresh = ago(API_KEY_LAST_USED_THROTTLE_MS / 2);

    for (let i = 0; i < 50; i++) {
      expect(
        await recordApiKeyUse({ id: "key-1", lastUsedAt: fresh }, NOW),
      ).toBe(false);
    }

    expect(updateMany).not.toHaveBeenCalled();
  });

  it("treats a value exactly at the throttle boundary as stale", async () => {
    const wrote = await recordApiKeyUse(
      { id: "key-1", lastUsedAt: ago(API_KEY_LAST_USED_THROTTLE_MS) },
      NOW,
    );
    expect(wrote).toBe(true);
  });

  // The read-side check can only see this replica's copy of the row. The
  // statement repeats the test so a burst that all read the same stale value
  // still results in one actual row change.
  it("repeats the staleness test in the statement, for concurrent writers", async () => {
    await recordApiKeyUse({ id: "key-1", lastUsedAt: null }, NOW);

    const staleBefore = new Date(NOW - API_KEY_LAST_USED_THROTTLE_MS);
    expect(lastCall()?.where.OR).toEqual([
      { lastUsedAt: null },
      { lastUsedAt: { lt: staleBefore } },
    ]);
  });

  it("swallows a database failure — telemetry never breaks authentication", async () => {
    updateMany.mockRejectedValueOnce(new Error("connection reset"));

    await expect(
      recordApiKeyUse({ id: "key-1", lastUsedAt: null }, NOW),
    ).resolves.toBe(true);
  });

  it("is a silent no-op when the caller did not select an id", async () => {
    const wrote = await recordApiKeyUse({ id: "", lastUsedAt: null }, NOW);

    expect(wrote).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
