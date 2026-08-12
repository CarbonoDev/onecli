import { parse as parsePublicSuffix } from "tldts";

/**
 * Canonical form and wire format for an organization's claimed email domains.
 *
 * `OrganizationDomain.domain` is GLOBALLY `@unique`, so normalization is not a
 * cosmetic nicety: `Example.COM`, `example.com.` and `münchen.de` must all
 * collapse to the one string the index sees, or the same name could be claimed
 * twice — once per spelling — by two different organizations. Every write path
 * runs a value through `normalizeDomain` before it reaches the database, and
 * every read compares against the normalized form.
 *
 * Pure and dependency-light so both the service and its tests can call it
 * directly.
 */

/** RFC 1035: the wire form of a name is at most 255 octets, 253 as text. */
const MAX_DOMAIN_LENGTH = 253;
/** RFC 1035: one label is at most 63 octets. */
const MAX_LABEL_LENGTH = 63;

/**
 * After IDNA the whole name is ASCII letter-digit-hyphen, so one expression
 * covers every label: no leading/trailing hyphen, no underscore, no empty
 * label. (The `_onecli-challenge` prefix we PUBLISH is not a claimable name —
 * it is only ever prepended at query time.)
 */
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Characters that mean the caller pasted a URL, an email address, or an IPv6
 * literal rather than a bare hostname. Rejected BEFORE `new URL` sees them, or
 * `https://user@evil.test/example.com` would normalize to `evil.test`.
 */
const NOT_A_BARE_HOSTNAME = /[\s/\\@:?#%[\]]/;

/** All-digit final label — an IP literal in some spelling we haven't caught. */
const NUMERIC_LABEL = /^\d+$/;

/**
 * The canonical form of `raw`, or `null` if it is not a domain anyone could
 * prove ownership of over DNS.
 *
 * Rejects: IP literals (in every spelling), `localhost` and anything under it,
 * bare labels, bare public suffixes (`com`, `co.uk` — nobody may claim a whole
 * registry), over-long names or labels, and anything carrying a scheme, path,
 * port, or userinfo.
 */
export const normalizeDomain = (raw: string): string | null => {
  // A trailing dot is the DNS root: `example.com.` and `example.com` name the
  // same zone, so they must never become two rows under the UNIQUE index.
  const trimmed = raw.trim().replace(/\.+$/, "");
  if (!trimmed || NOT_A_BARE_HOSTNAME.test(trimmed)) return null;

  // `URL` is the platform's own UTS-46/IDNA implementation: it lowercases and
  // punycodes in one step (`münchen.de` → `xn--mnchen-3ya.de`), which the
  // deprecated `node:punycode` module would only half do. It also canonicalises
  // the legacy numeric host forms (`0x7f.1` → `127.0.0.1`), so the IP check
  // below runs AFTER that rewrite rather than being fooled by the spelling.
  let hostname: string;
  try {
    hostname = new URL(`https://${trimmed}`).hostname;
  } catch {
    return null;
  }

  if (hostname.length > MAX_DOMAIN_LENGTH) return null;
  // Loopback and internal-only names can be "verified" by any caller who
  // controls their own resolver, which would make verification meaningless.
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return null;

  const labels = hostname.split(".");
  // At least one dot. A bare label is either a public suffix or an
  // internal-only name; neither is provable over public DNS.
  if (labels.length < 2) return null;
  if (NUMERIC_LABEL.test(labels[labels.length - 1] ?? "")) return null;
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > MAX_LABEL_LENGTH ||
        !LABEL.test(label),
    )
  ) {
    return null;
  }

  // The public-suffix pass the character rules cannot do: `isIp` catches the IP
  // literals `URL` normalized into place, and a null `domain` means the input
  // IS a public suffix (`com`, `co.uk`) rather than a name under one. Unknown
  // TLDs still resolve to a registrable domain, which is deliberate — a
  // self-hosted instance with an internal TLD must still be able to claim.
  const parsed = parsePublicSuffix(hostname, { allowPrivateDomains: false });
  if (parsed.isIp || !parsed.domain) return null;

  return hostname;
};

/**
 * The TXT record's OWNER NAME. Prefixed with an underscore label, the
 * convention for control records (`_dmarc`, `_acme-challenge`), so it can never
 * collide with a real host in the claimant's zone.
 */
export const challengeRecordName = (domain: string): string =>
  `_onecli-challenge.${domain}`;

/** The TXT record's VALUE — the token the claimant must publish verbatim. */
export const challengeRecordValue = (token: string): string =>
  `onecli-domain-verification=${token}`;
