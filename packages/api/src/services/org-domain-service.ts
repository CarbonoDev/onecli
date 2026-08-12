import { randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { db, Prisma } from "@onecli/db";
import { ServiceError } from "./errors";
import {
  challengeRecordName,
  challengeRecordValue,
  normalizeDomain,
} from "../lib/domain";

/**
 * The organization's claimed email domains: list / claim / verify / delete.
 *
 * ## The state model is the schema's, not ours
 *
 * `OrganizationDomain.verifiedAt` is the WHOLE state machine: null means
 * claimed-but-pending, non-null means verified. Every trust decision reads
 * `verifiedAt`, never mere row existence — a row is only ever an assertion by
 * whoever typed it until DNS backs it up.
 *
 * There is deliberately NO `failed` state. "Failed" is the outcome of a CHECK,
 * not a property of the domain: DNS may propagate thirty seconds after a miss,
 * so a persisted failure would be stale the moment it was written and would
 * make the row lie about the world. A miss therefore leaves the row completely
 * untouched and throws; the client holds that outcome in component state until
 * the next check.
 *
 * ## Scope
 *
 * Every read and write is scoped to ONE organization — the caller's
 * `auth.organizationId`, never a body parameter — with the `findFirst({ id,
 * organizationId })` / `deleteMany({ id, organizationId })` idiom the rest of
 * the org surface uses, so a cross-org id reads as absent (404) rather than
 * leaking or mutating another tenant's row.
 */

/** One row of the domains list. */
export interface OrgDomainRow {
  id: string;
  domain: string;
  /** ISO timestamp when DNS proved ownership; null = claimed, pending. */
  verifiedAt: string | null;
  /** The TXT record's owner name — what the claimant creates in their zone. */
  recordName: string;
  /** The TXT record's value — published verbatim. */
  recordValue: string;
  createdAt: string;
}

/** What a delete removed, for the route's audit metadata. */
export interface OrgDomainDeleteResult {
  id: string;
  domain: string;
  verified: boolean;
}

/**
 * A verification attempt's outcome.
 *
 * `changed` exists so the route can tell a real proof-of-ownership moment from
 * a re-check of an already-verified row. The second is a READ — it runs no
 * lookup and writes nothing — and auditing it would put N events in the log all
 * claiming the domain was verified, every one carrying the SAME original
 * timestamp, leaving an operator unable to identify the one that was the actual
 * proof.
 */
export interface VerifyOrgDomainResult {
  domain: OrgDomainRow;
  /** false = the row was already verified; nothing happened. */
  changed: boolean;
}

interface DomainRecord {
  id: string;
  domain: string;
  verificationToken: string;
  verifiedAt: Date | null;
  createdAt: Date;
}

const SELECT = {
  id: true,
  domain: true,
  verificationToken: true,
  verifiedAt: true,
  createdAt: true,
} as const;

const toRow = (row: DomainRecord): OrgDomainRow => ({
  id: row.id,
  domain: row.domain,
  verifiedAt: row.verifiedAt?.toISOString() ?? null,
  recordName: challengeRecordName(row.domain),
  recordValue: challengeRecordValue(row.verificationToken),
  createdAt: row.createdAt.toISOString(),
});

/**
 * 128 bits of entropy, hex-encoded. Long enough that guessing a pending
 * domain's token is not a path to hijacking the claim, short enough to fit a
 * TXT record comfortably (no 255-octet chunking on the publisher's side).
 */
const newVerificationToken = () => randomBytes(16).toString("hex");

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/**
 * `OrganizationDomain.domain` is unique GLOBALLY, not per-org, so a claim can
 * collide with a row this caller must never learn anything about. The message
 * is therefore NEUTRAL: naming (or even hinting at) the holder would turn this
 * endpoint into an oracle for enumerating another tenant's domain portfolio.
 */
const DOMAIN_TAKEN =
  "That domain is already claimed. Contact support if it belongs to your organization.";

/** Same-org collisions leak nothing the caller can't already list. */
const DOMAIN_ALREADY_YOURS = "You have already claimed this domain.";

/**
 * Ceiling on how many domains ONE organization may hold.
 *
 * An org claims the domains its people receive email at: one for most, a
 * handful for a company that has rebranded or absorbed others, a couple of
 * dozen for a conglomerate carrying every acquired brand. 25 is comfortably
 * above real use and far below the volume that makes this endpoint interesting
 * to abuse.
 *
 * It is a rate-limit floor, not an inventory rule. Without it an admin can
 * claim thousands of rows for zones they run the nameservers for, then fire a
 * verify at each: the cooldown keys on domain ID, so distinct rows never gate
 * each other, and every attempt opens an outbound lookup that `withDnsTimeout`
 * ABANDONS but cannot abort. That is a reflection pivot through this instance's
 * resolver at attacker-chosen authoritative servers, and a beacon announcing
 * the instance's DNS egress address. Capping the row count caps the fan-out.
 */
const MAX_ORG_DOMAINS = 25;

export const listOrgDomains = async (
  organizationId: string,
): Promise<OrgDomainRow[]> => {
  // No cursor envelope: an organization holds a handful of domains, not a
  // directory-scale set, and every consumer wants all of them at once.
  const rows = await db.organizationDomain.findMany({
    where: { organizationId },
    select: SELECT,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(toRow);
};

export const claimOrgDomain = async (
  organizationId: string,
  userId: string,
  rawDomain: string,
): Promise<OrgDomainRow> => {
  const domain = normalizeDomain(rawDomain);
  if (!domain) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "Enter a domain like example.com — not a URL, an email address, or an IP address.",
    );
  }

  const held = await db.organizationDomain.count({ where: { organizationId } });
  if (held >= MAX_ORG_DOMAINS) {
    throw new ServiceError(
      "CONFLICT",
      `An organization can hold at most ${MAX_ORG_DOMAINS} domains. Remove one before adding another.`,
    );
  }

  // Friendly pre-check for the common case; the P2002 catch below covers the
  // claim-claim race the pre-check cannot see.
  const existing = await db.organizationDomain.findUnique({
    where: { domain },
    select: { organizationId: true },
  });
  if (existing) {
    throw new ServiceError(
      "CONFLICT",
      existing.organizationId === organizationId
        ? DOMAIN_ALREADY_YOURS
        : DOMAIN_TAKEN,
    );
  }

  try {
    const row = await db.organizationDomain.create({
      // `verifiedAt` is left at its default null: a claim is an assertion, and
      // only `verifyOrgDomain` may ever set it.
      data: {
        organizationId,
        domain,
        verificationToken: newVerificationToken(),
        createdByUserId: userId,
      },
      select: SELECT,
    });
    return toRow(row);
  } catch (err) {
    // The racing claimant is unknown on this path, so the message stays the
    // neutral one — it may well belong to another organization.
    if (isUniqueViolation(err)) {
      throw new ServiceError("CONFLICT", DOMAIN_TAKEN);
    }
    throw err;
  }
};

// ── Verification ──────────────────────────────────────────────────────────

/**
 * Node's resolver has NO built-in deadline: a black-holed nameserver leaves
 * `resolveTxt` hanging for as long as the platform's retry schedule takes.
 * Three seconds is well past a healthy recursive lookup and well short of a
 * request timeout, so a click always gets an answer.
 */
const DNS_TIMEOUT_MS = 3_000;

/**
 * Floor between two checks on the SAME row. DNS changes take minutes at best,
 * so a faster retry can only produce the same answer — this exists to keep an
 * impatient click-through from turning into an outbound query flood.
 */
const VERIFY_COOLDOWN_MS = 10_000;

/** Marker for the deadline arm of the race, so it classifies as unreachable. */
class DnsTimeoutError extends Error {}

/**
 * In-memory, per-process cooldown clock, keyed by domain id.
 *
 * Deliberately not a column: this is rate limiting, not state — it must not
 * survive a restart, and persisting it would put a write on the failure path
 * that is required to leave the row untouched.
 *
 * TWO LIMITS, stated plainly rather than hedged. (1) THE COOLDOWN DOES NOT
 * APPLY ACROSS PROCESSES. The shipped image is a single process, but nothing
 * enforces that, and behind two replicas a caller gets one window per replica.
 * (2) It gates one ROW, not the org — `MAX_ORG_DOMAINS` is what bounds the
 * total outbound fan-out, because distinct rows never gate each other. A
 * deployment that needs a real limit wants a shared limiter keyed on the org,
 * not a bigger version of this map.
 */
const lastVerifyAttempt = new Map<string, number>();

/**
 * Keeps the map bounded: entries older than the window can never gate again.
 * O(n) per call, so a flood of n concurrent verifies is O(n²) — tolerable only
 * because `MAX_ORG_DOMAINS` keeps n at two digits per org.
 */
const sweepCooldowns = (now: number) => {
  for (const [id, at] of lastVerifyAttempt) {
    if (now - at >= VERIFY_COOLDOWN_MS) lastVerifyAttempt.delete(id);
  }
};

const withDnsTimeout = async <T>(work: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new DnsTimeoutError("DNS lookup timed out")),
          DNS_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const errorCode = (err: unknown): string | undefined =>
  typeof err === "object" && err !== null && "code" in err
    ? String(err.code)
    : undefined;

/**
 * Failures that are the CLAIMANT's side of the problem, not the instance's.
 *
 * `ENOTFOUND`/`ENODATA` are the ordinary "not published yet" answers while DNS
 * propagates. `EBADNAME` means c-ares refused to emit the query at all because
 * the name is malformed — an input problem; `normalizeDomain`'s length cap
 * makes it unreachable from the claim path, but bucketing it here is what keeps
 * an input defect from ever being reported as broken egress DNS.
 *
 * `NXDOMAIN` is deliberately absent: c-ares surfaces that condition as
 * `ENOTFOUND` and Node never emits the string, so listing it would be dead code
 * with a test giving it false coverage.
 */
const NO_RECORD_CODES = new Set(["ENOTFOUND", "ENODATA", "EBADNAME"]);

const noRecordMessage = (recordName: string) =>
  `No matching TXT record found at ${recordName}. DNS changes can take up to an hour to propagate.`;

/**
 * THE distinction that matters for self-hosted. A miss is the claimant's
 * problem (publish the record, wait); an unreachable resolver is the
 * OPERATOR's problem (this instance has no outbound DNS), and telling them to
 * "wait for propagation" would send them chasing a record that is already
 * there.
 */
const UNREACHABLE_MESSAGE =
  "Couldn't reach DNS from this instance. Check the server's outbound DNS and try again.";

const dnsFailure = (err: unknown, recordName: string): ServiceError => {
  const code = errorCode(err);
  if (!(err instanceof DnsTimeoutError) && code && NO_RECORD_CODES.has(code)) {
    return new ServiceError("BAD_REQUEST", noRecordMessage(recordName));
  }
  // ESERVFAIL, ECONNREFUSED, ETIMEOUT, our own deadline, anything unrecognised
  // — all of them mean we did not get an authoritative answer, so none of them
  // may be reported as "the record isn't there".
  return new ServiceError("BAD_REQUEST", UNREACHABLE_MESSAGE);
};

/**
 * `resolveTxt` answers `string[][]`: one inner array per record, split into the
 * 255-octet chunks the wire format demands. A record's real value is its chunks
 * CONCATENATED — comparing chunk-by-chunk would miss any token a provider
 * chose to split.
 *
 * Lowercased on both sides of the comparison: some DNS panels normalize the
 * case of a TXT value they store, and the token is hex, so case carries no
 * entropy to lose. Without this an uppercasing provider produces a permanent
 * "no matching record" against a record that is demonstrably correct.
 */
const flattenTxt = (records: string[][]): string[] =>
  records.map((chunks) => chunks.join("").trim().toLowerCase());

export const verifyOrgDomain = async (
  organizationId: string,
  domainId: string,
): Promise<VerifyOrgDomainResult> => {
  const row = await db.organizationDomain.findFirst({
    where: { id: domainId, organizationId },
    select: SELECT,
  });
  if (!row) throw new ServiceError("NOT_FOUND", "Domain not found.");

  // Re-verifying a verified domain is a no-op, not an error: the UI may race a
  // refetch against a click, and the answer is already known. Reported as
  // `changed: false` so the route does not audit a read — see
  // `VerifyOrgDomainResult`.
  if (row.verifiedAt) return { domain: toRow(row), changed: false };

  const now = Date.now();
  sweepCooldowns(now);
  const previous = lastVerifyAttempt.get(domainId);
  if (previous !== undefined && now - previous < VERIFY_COOLDOWN_MS) {
    throw new ServiceError(
      "CONFLICT",
      "Verification was just attempted. Wait a few seconds before checking again.",
    );
  }
  lastVerifyAttempt.set(domainId, now);

  const recordName = challengeRecordName(row.domain);
  const expected = challengeRecordValue(row.verificationToken);

  let records: string[][];
  try {
    records = await withDnsTimeout(resolveTxt(recordName));
  } catch (err) {
    throw dnsFailure(err, recordName);
  }

  if (!flattenTxt(records).includes(expected.toLowerCase())) {
    // The row is left EXACTLY as it was — no failure marker, no timestamp.
    throw new ServiceError("BAD_REQUEST", noRecordMessage(recordName));
  }

  // Org-scoped conditional write: a count of 0 means the row was deleted
  // between the read and the write, which is a 404 rather than the P2025 500 a
  // bare `update()` would surface.
  const verifiedAt = new Date();
  const { count } = await db.organizationDomain.updateMany({
    where: { id: domainId, organizationId },
    data: { verifiedAt },
  });
  if (count === 0) throw new ServiceError("NOT_FOUND", "Domain not found.");

  lastVerifyAttempt.delete(domainId);
  return { domain: toRow({ ...row, verifiedAt }), changed: true };
};

export const deleteOrgDomain = async (
  organizationId: string,
  domainId: string,
): Promise<OrgDomainDeleteResult> => {
  const row = await db.organizationDomain.findFirst({
    where: { id: domainId, organizationId },
    select: { id: true, domain: true, verifiedAt: true },
  });
  if (!row) throw new ServiceError("NOT_FOUND", "Domain not found.");

  const { count } = await db.organizationDomain.deleteMany({
    where: { id: domainId, organizationId },
  });
  if (count === 0) throw new ServiceError("NOT_FOUND", "Domain not found.");

  // The id is free for reuse by nothing, but a stale cooldown entry would
  // gate a fresh claim's first check if the id ever came back.
  lastVerifyAttempt.delete(domainId);

  return {
    id: row.id,
    domain: row.domain,
    verified: row.verifiedAt !== null,
  };
};
