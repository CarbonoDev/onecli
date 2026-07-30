// Shared syntax checks for behavioral rule conditions, used by BOTH the API's
// `ruleConditionSchema` and the web condition builder's inline validation
// (`apps/web/src/lib/components/condition-builder/validate.ts`) so the two can
// never drift. Deliberately zod-free: the web imports this at runtime.

// RFC 9110 token charset — exactly the names the gateway's
// `HeaderName::from_bytes` accepts. A key outside this set (embedded space,
// trailing copy-paste whitespace) would save fine but be permanently
// unevaluable on the gateway: a Block rule would over-block everything it
// targets and an Allow rule would silently never apply.
const HEADER_NAME_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export const isValidHeaderName = (key: string): boolean =>
  HEADER_NAME_TOKEN.test(key);

/**
 * Best-effort JS compile check for a gateway (Rust `regex`) pattern. The
 * gateway is the authoritative fail-closed backstop; this exists purely so a
 * typo surfaces before save. Rust-only syntax that JS `RegExp` lacks is
 * normalized away first — a false ACCEPT is safe, a false REJECT would block
 * valid gateway patterns:
 * - standalone inline flag groups `(?i)` → removed
 * - scoped flag groups `(?i:…)` → plain group `(?:…)`
 * - named groups `(?P<name>…)` → JS named groups `(?<name>…)`
 */
export const compilesAsConditionRegex = (pattern: string): boolean => {
  try {
    new RegExp(
      pattern
        .replace(/\(\?[a-zA-Z-]+\)/g, "")
        .replace(/\(\?[a-zA-Z-]+:/g, "(?:")
        .replace(/\(\?P</g, "(?<"),
    );
    return true;
  } catch {
    return false;
  }
};
