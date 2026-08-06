import { randomUUID } from "crypto";
import { db } from "@onecli/db";
import { ServiceError } from "./errors";

/**
 * Resolve a `ClientHost`'s stable identity for an enrollment request: either
 * mints a brand-new one, or reuses an existing one for renewal.
 *
 * `ClientHost` is per-HOST, not per-enrollment call: this is what makes
 * `spiffeUri` a durable identity a relay can keep presenting across
 * certificate renewals (re-calling this same endpoint, short-lived certs by
 * design) rather than a new row — and identity — minted every time.
 *
 * - `hostId` omitted (first enrollment): create a fresh row, server-generated
 *   `id` + `spiffe://onecli/host/<id>`, and return it.
 * - `hostId` provided (renewal): look up that row SCOPED TO `projectId` —
 *   the caller's own tenant, from `AuthContext`, never trust the client's
 *   `hostId` alone — and reuse its existing `id`/`spiffeUri`. Never falls
 *   through to creating a new row on a lookup miss.
 *
 * IDOR guard: `findFirst({ where: { id: hostId, projectId } })` returns
 * nothing for BOTH "no such host" and "that host belongs to a different
 * project" — the two cases are handled identically (a `NOT_FOUND` thrown
 * here, not silently falling through to `create`), so a caller probing
 * another tenant's `hostId` cannot distinguish "wrong tenant" from "doesn't
 * exist" and never learns anything about a row it doesn't own.
 *
 * The id is generated client-side (`randomUUID()`, passed explicitly to
 * `create` instead of relying on the schema's `@default(uuid())`)
 * specifically so `spiffeUri` can be derived from it and written in the same
 * insert; deriving it from a DB-assigned id would need a second round-trip
 * update, racy on the column's `@unique` constraint if two enrollments ever
 * landed between create and update.
 *
 * `label` has no uniqueness constraint (it's a human-readable hint, not an
 * identifier) — a project can enroll multiple unlabeled hosts, each getting
 * its own row and its own spiffe URI.
 */
export const ensureClientHost = async (
  projectId: string,
  organizationId: string | undefined,
  label: string | undefined,
  hostId: string | undefined,
): Promise<{ id: string; spiffeUri: string }> => {
  if (hostId) {
    const existing = await db.clientHost.findFirst({
      where: { id: hostId, projectId },
      select: { id: true, spiffeUri: true },
    });
    if (!existing) {
      throw new ServiceError("NOT_FOUND", "Client host not found");
    }
    return existing;
  }

  const id = randomUUID();
  const spiffeUri = `spiffe://onecli/host/${id}`;

  const host = await db.clientHost.create({
    data: {
      id,
      projectId,
      organizationId,
      label,
      spiffeUri,
    },
    select: { id: true, spiffeUri: true },
  });

  return host;
};

/**
 * Stamp `lastSerial`/`lastIssuedAt` on a `ClientHost` row after a successful
 * mint. Never touches `revokedAt` — that field has no writer yet (see its
 * schema doc comment); this is purely a "when did we last mint" record.
 */
export const stampClientHostIssued = async (
  hostId: string,
  serial: string,
): Promise<void> => {
  await db.clientHost.update({
    where: { id: hostId },
    data: { lastSerial: serial, lastIssuedAt: new Date() },
  });
};
