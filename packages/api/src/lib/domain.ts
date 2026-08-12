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
const MAX_NAME_LENGTH = 253;
/** RFC 1035: one label is at most 63 octets. */
const MAX_LABEL_LENGTH = 63;

/**
 * The budget the challenge prefix spends out of `MAX_NAME_LENGTH`.
 *
 * A claimable domain is NOT capped at 253: we never query the domain itself,
 * we query `_onecli-challenge.<domain>`. A 247-char domain is a legal name but
 * yields a 265-char QUERY name, and c-ares rejects that as `EBADNAME`
 * instantly, without emitting a packet. That surfaces as a resolver failure —
 * inverting the failure taxonomy and sending a self-hosted operator to audit
 * healthy egress DNS over what is really an input-length problem. So the cap
 * that matters is the one the CHALLENGE name has to satisfy.
 */
const CHALLENGE_PREFIX = "_onecli-challenge";

/** 253 − len("_onecli-challenge.") = 235. */
const MAX_DOMAIN_LENGTH = MAX_NAME_LENGTH - (CHALLENGE_PREFIX.length + 1);

/**
 * Names DNS reserves for local, private, or documentation use: RFC 6761
 * (`localhost`, `test`, `invalid`, `example`), RFC 6762 (`local`, mDNS),
 * RFC 9476 (`alt`), RFC 8375 (`home.arpa`), and the strings ICANN blocked from
 * delegation because enterprises already use them internally.
 *
 * None of these is provable. Ownership here means "an authoritative server the
 * public internet agrees on published our token" — but a self-hosted instance
 * resolves these through whatever local zone its operator points it at, so
 * anyone who can write that zone could mint a "verified" domain they do not own
 * publicly. That is the same argument that rules out `localhost`; it applies
 * identically to every name below.
 */
const RESERVED_TLDS = new Set([
  "localhost",
  "local",
  "test",
  "invalid",
  "example",
  "alt",
  "internal",
  "intranet",
  "private",
  "corp",
  "home",
  "lan",
]);

/** Reserved names below the TLD level (RFC 8375's `home.arpa`). */
const RESERVED_NAMES = new Set(["home.arpa"]);

const isReservedName = (hostname: string, labels: string[]): boolean => {
  if (RESERVED_TLDS.has(labels[labels.length - 1] ?? "")) return true;
  for (const name of RESERVED_NAMES) {
    if (hostname === name || hostname.endsWith(`.${name}`)) return true;
  }
  return false;
};

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
 * Rejects: IP literals (in every spelling), reserved and internal-only names
 * (`localhost`, `.local`, `.internal`, `home.arpa`, …), bare labels, bare
 * public suffixes — including PRIVATE ones like `github.io` and `vercel.app`,
 * so nobody squats a namespace thousands of unrelated parties hold subdomains
 * under — names too long to carry the challenge prefix, over-long labels, and
 * anything carrying a scheme, path, port, or userinfo.
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

  // Bounded so `challengeRecordName(domain)` still fits in a legal query name.
  if (hostname.length > MAX_DOMAIN_LENGTH) return null;

  const labels = hostname.split(".");
  // At least one dot. A bare label is either a public suffix or an
  // internal-only name; neither is provable over public DNS.
  if (labels.length < 2) return null;
  if (NUMERIC_LABEL.test(labels[labels.length - 1] ?? "")) return null;
  if (isReservedName(hostname, labels)) return null;
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
  // IS a suffix rather than a name under one.
  //
  // `allowPrivateDomains` is ON, so the PRIVATE registry list counts too:
  // `github.io`, `vercel.app`, `pages.dev`, `herokuapp.com` and friends are
  // namespaces thousands of unrelated parties hold subdomains under. Nobody
  // could verify the shared root anyway, but a claim on it is a permanent squat
  // on the global unique index. Subdomains are unaffected — `user.github.io`
  // still parses to a registrable domain and remains claimable.
  const parsed = parsePublicSuffix(hostname, { allowPrivateDomains: true });
  if (parsed.isIp || !parsed.domain) return null;

  return hostname;
};

/**
 * The TXT record's OWNER NAME. Prefixed with an underscore label, the
 * convention for control records (`_dmarc`, `_acme-challenge`), so it can never
 * collide with a real host in the claimant's zone.
 *
 * `normalizeDomain` bounds its input so this always fits a legal query name.
 */
export const challengeRecordName = (domain: string): string =>
  `${CHALLENGE_PREFIX}.${domain}`;

/** The TXT record's VALUE — the token the claimant must publish verbatim. */
export const challengeRecordValue = (token: string): string =>
  `onecli-domain-verification=${token}`;
