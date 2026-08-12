// The single source for how a secret is shown on screen. Both the Overview
// API key card and the Install page's commands mask through this — two
// implementations would drift, and a drift here is a leak.

const VISIBLE_PREFIX = 6;
const VISIBLE_SUFFIX = 4;
const BULLETS = 12;

// Below this, prefix + suffix would reveal most of the value, so mask it whole.
const SHORT_VALUE_LENGTH = 10;

export const maskSecret = (value: string): string => {
  if (value.length <= SHORT_VALUE_LENGTH) return "•".repeat(8);
  return `${value.slice(0, VISIBLE_PREFIX)}${"•".repeat(BULLETS)}${value.slice(-VISIBLE_SUFFIX)}`;
};
