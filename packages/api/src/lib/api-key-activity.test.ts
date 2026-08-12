import { describe, expect, it } from "vitest";

import {
  API_KEY_USAGE_TRACKED_SINCE,
  apiKeyLastUsed,
} from "./api-key-activity";

const NOW = Date.parse("2026-09-20T12:00:00Z");
const at = (msAgo: number) => new Date(NOW - msAgo);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("apiKeyLastUsed", () => {
  it("says 'used', not 'seen' — a key is presented, never present", () => {
    expect(apiKeyLastUsed(at(3 * HOUR), at(90 * DAY), NOW).label).toBe(
      "Last used 3h ago",
    );
  });

  it("lowercases the just-now arm so it reads mid-sentence", () => {
    expect(apiKeyLastUsed(at(10 * 1000), at(90 * DAY), NOW).label).toBe(
      "Last used just now",
    );
  });

  it("attaches the exact timestamp for the hover title", () => {
    const used = apiKeyLastUsed(at(5 * 60 * 1000), at(90 * DAY), NOW);
    expect(used.exactAt?.getTime()).toBe(NOW - 5 * 60 * 1000);
  });

  it("is fresh only within the last hour", () => {
    expect(apiKeyLastUsed(at(59 * 60 * 1000), at(90 * DAY), NOW).fresh).toBe(
      true,
    );
    expect(apiKeyLastUsed(at(61 * 60 * 1000), at(90 * DAY), NOW).fresh).toBe(
      false,
    );
  });

  // A key minted after the column started recording and still null has
  // provably never authenticated — that is the reading an operator acts on.
  it("null on a key minted since tracking began = provably never used", () => {
    const created = new Date(API_KEY_USAGE_TRACKED_SINCE + DAY);
    expect(apiKeyLastUsed(null, created, NOW)).toEqual({
      label: "Never used",
      exactAt: null,
      fresh: false,
    });
  });

  // A key older than the column cannot be called "never" — its null may just
  // predate the tracking. Overclaiming here would tell an operator a leaked
  // key was dormant when nothing was ever watching it.
  it("null on a key older than tracking = quiet, not never", () => {
    const created = new Date(API_KEY_USAGE_TRACKED_SINCE - DAY);
    expect(apiKeyLastUsed(null, created, NOW).label).toBe("No recent activity");
  });

  it("accepts ISO strings, which is how the dashboard receives them", () => {
    const used = apiKeyLastUsed(
      at(2 * DAY).toISOString(),
      at(90 * DAY).toISOString(),
      NOW,
    );
    expect(used.label).toBe("Last used 2d ago");
  });
});
