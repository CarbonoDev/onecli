import { Hono } from "hono";
import type { Context } from "hono";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { ServiceError } from "../../services/errors";
import { parse } from "./parse";
import {
  claimOrgDomain,
  deleteOrgDomain,
  listOrgDomains,
  verifyOrgDomain,
} from "../../services/org-domain-service";
import { claimDomainSchema } from "../../validations/org";
import {
  withAudit,
  recordAuditEvent,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../../services/audit-service";

/**
 * `/v1/org/domains` — the organization's claimed email domains.
 *
 * Same guard stack as `/v1/org/groups`, for the same reasons:
 *
 * `requireProject: false`: these are ORG-scoped routes, so a caller with no
 * project context (an org API key without `X-Project-Id`) must still get
 * through. `role: "admin"` makes the whole router admin-only — a plain member
 * gets a deterministic 403, which is exactly what the web client expects.
 *
 * `role` alone is SCOPE-BLIND, so it is not sufficient on its own: a
 * project-scoped key (the credential an agent carries) resolves to its owning
 * user, and if that user happens to be an org admin the role check passes. A
 * leaked agent key could then claim domains in the org's name — and a verified
 * domain is the substrate enterprise sign-in hangs off. Org-wide authority
 * requires an org-wide credential, so project-scoped callers are rejected
 * outright.
 */
export const ossOrgDomainRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", auth({ requireProject: false, role: "admin" }));
  app.use("*", async (c, next) => {
    if (c.get("auth").scope === "project") {
      throw new ServiceError(
        "FORBIDDEN",
        "Organization management requires an organization-scoped credential.",
      );
    }
    return next();
  });

  const auditBase = (c: Context<ApiEnv>) => ({
    organizationId: c.get("auth").organizationId,
    userId: c.get("auth").userId,
    userEmail: c.get("auth").userEmail,
    service: AUDIT_SERVICES.DOMAIN,
    source: AUDIT_SOURCE.API,
  });

  // GET /org/domains — the whole set (an org holds a handful, not a directory).
  app.get("/", async (c) => {
    const { organizationId } = c.get("auth");
    return c.json(await listOrgDomains(organizationId));
  });

  // POST /org/domains — claim a domain. The row starts PENDING: the response
  // carries the TXT record the caller must publish before it means anything.
  app.post("/", async (c) => {
    const { organizationId, userId } = c.get("auth");
    const body = await c.req.json().catch(() => null);
    const input = parse(claimDomainSchema, body);

    const domain = await withAudit(
      () => claimOrgDomain(organizationId, userId, input.domain),
      (created) => ({
        ...auditBase(c),
        action: AUDIT_ACTIONS.CREATE,
        // The stored (normalized) name, never the raw input, and never the
        // verification token — audit metadata carries identifiers, not secrets.
        metadata: { domainId: created.id, domain: created.domain },
      }),
    );
    return c.json(domain);
  });

  // POST /org/domains/:domainId/verify — run the DNS check.
  //
  // ONLY A REAL STATE CHANGE IS AUDITED, and this is the one route where that
  // takes explicit work. Two non-events have to stay out of the log:
  //
  //  - A MISS throws, so nothing below it runs. "We looked and the record
  //    wasn't there yet" is not a change to the organization.
  //  - A re-check of an ALREADY-VERIFIED row succeeds while changing nothing.
  //    `withAudit` always logs, so wrapping it would let a double-click or a
  //    polling client write N events each claiming the domain was verified,
  //    every one carrying the same original timestamp — leaving an operator
  //    unable to tell which was the actual proof-of-ownership moment, and
  //    costing an unbounded number of audit rows for a call that touches no
  //    DNS. It is a READ, and CLAUDE.md does not audit reads.
  //
  // Hence `recordAuditEvent` rather than `withAudit` — the documented seam for
  // a conditional state change. Nothing in the gateway's principal resolution
  // reads `OrganizationDomain` (this edition has no SSO), so skipping
  // `withAudit`'s org cache flush costs nothing.
  app.post("/:domainId/verify", async (c) => {
    const { organizationId } = c.get("auth");
    const domainId = c.req.param("domainId");

    const { domain, changed } = await verifyOrgDomain(organizationId, domainId);
    if (changed) {
      await recordAuditEvent({
        ...auditBase(c),
        action: AUDIT_ACTIONS.UPDATE,
        metadata: {
          domainId: domain.id,
          domain: domain.domain,
          change: "verified",
          verifiedAt: domain.verifiedAt,
        },
      });
    }
    return c.json(domain);
  });

  // DELETE /org/domains/:domainId — release the claim.
  app.delete("/:domainId", async (c) => {
    const { organizationId } = c.get("auth");
    const domainId = c.req.param("domainId");

    const result = await withAudit(
      () => deleteOrgDomain(organizationId, domainId),
      (deleted) => ({
        ...auditBase(c),
        action: AUDIT_ACTIONS.DELETE,
        // `verified` is the fact an operator reading the log needs: releasing
        // a VERIFIED domain gives up proven ownership, and the next claimant
        // (in any organization) starts from scratch.
        metadata: {
          domainId: deleted.id,
          domain: deleted.domain,
          verified: deleted.verified,
        },
      }),
    );
    return c.json(result);
  });

  return app;
};
