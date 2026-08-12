import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../../types";

// `/v1/org/domains` end-to-end through the real app: the OSS org routes
// mounted on the `eeRoutes` seam, the OSS role resolver wired as the
// RoleResolver, and `CAPS.rbac` on. Admin callers arrive with an org API key
// (whose key path re-checks admin through the resolver); the non-admin cases
// use a session, since a non-admin's org key fails key authentication
// outright. (Same harness as groups.test.ts — cloned, not shared.)
//
// `node:dns/promises` is mocked wholesale: the verification path must be
// testable without reaching a resolver, and its whole contract is what it does
// with what `resolveTxt` answers.

const ORG = "org-1";
const OTHER_ORG = "org-2";
const OWNER = "user-owner";
const ADMIN = "user-admin";
const MEMBER = "user-member";
const OUTSIDER = "user-outsider";
const ADMIN_KEY = "oc_org_admin-key";
const PROJECT_KEY = "oc_project-key-of-owner";

const TOKEN = "0123456789abcdef0123456789abcdef";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "oss";
  process.env.SECRET_ENCRYPTION_KEY = "test-secret";
  process.env.OAUTH_STATE_SECRET = "test-secret";
});

const dns = vi.hoisted(() => ({ resolveTxt: vi.fn() }));

vi.mock("node:dns/promises", () => ({ resolveTxt: dns.resolveTxt }));

interface MemberRow {
  organizationId: string;
  userId: string;
  userEmail: string;
  role: string;
  status: string;
  ssoExempt: boolean;
  suspendedAt: Date | null;
  createdAt: Date;
}

interface UserRow {
  id: string;
  externalAuthId: string;
  email: string;
  name: string | null;
}

interface DomainRow {
  id: string;
  organizationId: string;
  domain: string;
  verificationToken: string;
  verifiedAt: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface AuditRow {
  organizationId?: string;
  userId: string;
  action: string;
  service: string;
  source: string;
  metadata: Record<string, unknown>;
}

const store = vi.hoisted(() => ({
  members: [] as MemberRow[],
  users: [] as UserRow[],
  domains: [] as DomainRow[],
  audits: [] as AuditRow[],
  seq: 0,
  /** Simulate a claim-claim race: the pre-check misses, the create P2002s. */
  race: false,
  /** Which user the session provider resolves to (null = no session). */
  sessionUserId: null as string | null,
}));

vi.mock("@onecli/db", () => {
  class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }

  interface DomainWhere {
    id?: string;
    organizationId?: string;
    domain?: string;
  }
  interface DomainSelect {
    id?: boolean;
    domain?: boolean;
    verificationToken?: boolean;
    verifiedAt?: boolean;
    organizationId?: boolean;
    createdAt?: boolean;
  }
  interface OrgMemberWhere {
    organizationId?: string;
    userId?: string | { in: string[] };
    role?: string | { not?: string };
    status?: string | { not?: string };
  }

  const filterDomains = (where: DomainWhere) =>
    store.domains.filter(
      (row) =>
        (where.id === undefined || row.id === where.id) &&
        (where.organizationId === undefined ||
          row.organizationId === where.organizationId) &&
        (where.domain === undefined || row.domain === where.domain),
    );

  // Mirror Prisma's `select` so a route can't leak a column the service didn't
  // ask for — `verificationToken` in particular reaches the client only
  // through the record fields the service builds.
  const pickDomain = (row: DomainRow, select?: DomainSelect) => {
    if (!select) return { ...row };
    const picked: Record<string, unknown> = {};
    for (const key of [
      "id",
      "domain",
      "verificationToken",
      "verifiedAt",
      "organizationId",
      "createdAt",
    ] as const) {
      if (select[key]) picked[key] = row[key];
    }
    return picked;
  };

  const findMember = (organizationId: string, userId: string) =>
    store.members.find(
      (row) => row.organizationId === organizationId && row.userId === userId,
    );

  const filterOrgMembers = (where: OrgMemberWhere) =>
    store.members.filter((row) => {
      if (
        where.organizationId !== undefined &&
        row.organizationId !== where.organizationId
      )
        return false;
      if (typeof where.userId === "string" && row.userId !== where.userId)
        return false;
      if (
        typeof where.userId === "object" &&
        where.userId !== null &&
        !where.userId.in.includes(row.userId)
      )
        return false;
      if (where.status !== undefined) {
        const ok =
          typeof where.status === "string"
            ? row.status === where.status
            : where.status.not === undefined || row.status !== where.status.not;
        if (!ok) return false;
      }
      return true;
    });

  return {
    Prisma: { JsonNull: null, PrismaClientKnownRequestError },
    db: {
      apiKey: {
        findUnique: async ({ where }: { where: { key?: string } }) => {
          if (where.key === "oc_org_admin-key")
            return {
              userId: "user-admin",
              organizationId: "org-1",
              scope: "organization",
            };
          // A PROJECT-scoped key owned by the org's OWNER: it authenticates
          // fine, which is exactly why the router needs its own scope guard.
          if (where.key === "oc_project-key-of-owner")
            return { userId: "user-owner", projectId: "proj-1" };
          return null;
        },
        findFirst: async () => null,
        findMany: async () => [],
      },
      user: {
        findUnique: async ({
          where,
          select,
        }: {
          where: { id?: string; externalAuthId?: string; email?: string };
          select?: Record<string, unknown>;
        }) => {
          if (select?.organizationMemberships) {
            return {
              organizationMemberships: store.members
                .filter((m) => m.userId === where.id)
                .map((m) => ({ organizationId: m.organizationId })),
            };
          }
          return (
            store.users.find(
              (u) =>
                (where.id !== undefined && u.id === where.id) ||
                (where.externalAuthId !== undefined &&
                  u.externalAuthId === where.externalAuthId) ||
                (where.email !== undefined && u.email === where.email),
            ) ?? null
          );
        },
      },
      organizationMember: {
        findUnique: async ({
          where,
        }: {
          where: {
            organizationId_userId: { organizationId: string; userId: string };
          };
        }) => {
          const { organizationId, userId } = where.organizationId_userId;
          return findMember(organizationId, userId) ?? null;
        },
        findFirst: async ({ where }: { where: OrgMemberWhere }) =>
          filterOrgMembers(where)[0] ?? null,
        findMany: async ({ where }: { where: OrgMemberWhere }) =>
          filterOrgMembers(where),
        count: async () => 0,
      },
      organizationDomain: {
        // Backs the per-org cap. Org-scoped, unlike `findUnique` below.
        count: async ({ where }: { where: DomainWhere }) =>
          filterDomains(where).length,
        // The GLOBAL unique index: keyed by `domain` alone, with NO org filter —
        // which is exactly the cross-tenant collision the claim path handles.
        findUnique: async ({
          where,
          select,
        }: {
          where: { domain: string };
          select?: DomainSelect;
        }) => {
          if (store.race) return null;
          const row = store.domains.find((d) => d.domain === where.domain);
          return row ? pickDomain(row, select) : null;
        },
        findFirst: async ({
          where,
          select,
        }: {
          where: DomainWhere;
          select?: DomainSelect;
        }) => {
          const row = filterDomains(where)[0];
          return row ? pickDomain(row, select) : null;
        },
        findMany: async ({
          where,
          select,
        }: {
          where: DomainWhere;
          select?: DomainSelect;
        }) => {
          const rows = filterDomains(where)
            .slice()
            .sort(
              (a, b) =>
                a.createdAt.getTime() - b.createdAt.getTime() ||
                a.id.localeCompare(b.id),
            );
          return rows.map((row) => pickDomain(row, select));
        },
        create: async ({
          data,
          select,
        }: {
          data: {
            organizationId: string;
            domain: string;
            verificationToken: string;
            createdByUserId: string | null;
          };
          select?: DomainSelect;
        }) => {
          if (store.domains.some((d) => d.domain === data.domain)) {
            throw new PrismaClientKnownRequestError(
              "Unique constraint failed",
              "P2002",
            );
          }
          const row: DomainRow = {
            id: `d-${++store.seq}`,
            organizationId: data.organizationId,
            domain: data.domain,
            verificationToken: data.verificationToken,
            verifiedAt: null,
            createdByUserId: data.createdByUserId,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          store.domains.push(row);
          return pickDomain(row, select);
        },
        updateMany: async ({
          where,
          data,
        }: {
          where: DomainWhere;
          data: { verifiedAt: Date };
        }) => {
          const rows = filterDomains(where);
          for (const row of rows) {
            row.verifiedAt = data.verifiedAt;
            row.updatedAt = new Date();
          }
          return { count: rows.length };
        },
        deleteMany: async ({ where }: { where: DomainWhere }) => {
          const rows = filterDomains(where);
          const ids = new Set(rows.map((r) => r.id));
          store.domains = store.domains.filter((d) => !ids.has(d.id));
          return { count: rows.length };
        },
      },
      project: {
        findFirst: async () => ({ id: "proj-1", organizationId: "org-1" }),
        findUnique: async () => ({ id: "proj-1", organizationId: "org-1" }),
      },
      projectAccess: { findFirst: async () => null },
      auditLog: {
        create: async ({ data }: { data: AuditRow }) => {
          store.audits.push(data);
          return data;
        },
      },
      $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
    },
  };
});

import { createApiApp } from "../../app";
import { registerOssOrgRoutes } from "./index";
import { ossRoleResolver } from "../../services/org-role-resolver";

const sessionProvider = {
  getSession: async () => {
    const user = store.users.find((u) => u.id === store.sessionUserId);
    return user ? { id: user.externalAuthId, email: user.email } : null;
  },
};

const app: Hono<ApiEnv> = createApiApp(sessionProvider, {
  eeRoutes: registerOssOrgRoutes,
  roleResolver: ossRoleResolver,
});

const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes));

const member = (
  userId: string,
  role: string,
  createdAt: Date,
  organizationId = ORG,
): MemberRow => ({
  organizationId,
  userId,
  userEmail: `${userId}@example.com`,
  role,
  status: "active",
  ssoExempt: false,
  suspendedAt: null,
  createdAt,
});

const domain = (
  id: string,
  name: string,
  overrides: Partial<DomainRow> = {},
): DomainRow => ({
  id,
  organizationId: ORG,
  domain: name,
  verificationToken: TOKEN,
  verifiedAt: null,
  createdByUserId: ADMIN,
  createdAt: at(10),
  updatedAt: at(10),
  ...overrides,
});

/**
 * The re-verify cooldown is an in-memory, per-PROCESS clock keyed by domain id,
 * so it survives `beforeEach` — every test would otherwise inherit the previous
 * one's window on the same seeded ids. `Date.now` is driven forward a full
 * window between tests; the cooldown case advances it deliberately by less.
 */
let clock = Date.UTC(2026, 5, 1);
const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
afterAll(() => nowSpy.mockRestore());

beforeEach(() => {
  clock += 60_000;
  store.users = [
    {
      id: OWNER,
      externalAuthId: "ext-owner",
      email: "owner@example.com",
      name: "Olive Owner",
    },
    {
      id: ADMIN,
      externalAuthId: "ext-admin",
      email: "admin@example.com",
      name: "Adam Admin",
    },
    {
      id: MEMBER,
      externalAuthId: "ext-member",
      email: "member@elsewhere.test",
      name: null,
    },
    {
      id: OUTSIDER,
      externalAuthId: "ext-outsider",
      email: "outsider@other.test",
      name: "Odette Outsider",
    },
  ];
  store.members = [
    member(OWNER, "owner", at(0)),
    member(ADMIN, "admin", at(1)),
    member(MEMBER, "member", at(2)),
    member(OUTSIDER, "admin", at(3), OTHER_ORG),
  ];
  store.domains = [
    domain("d-pending", "acme.com", { createdAt: at(10) }),
    domain("d-verified", "acme-verified.com", {
      verifiedAt: at(30),
      createdAt: at(11),
    }),
    // A domain held by ANOTHER organization — the global unique index's whole
    // point, and the row this org must learn nothing about.
    domain("d-foreign", "rival.com", {
      organizationId: OTHER_ORG,
      createdAt: at(12),
    }),
  ];
  store.audits = [];
  store.seq = 100;
  store.race = false;
  store.sessionUserId = null;
  dns.resolveTxt.mockReset();
});

const domainRow = (id: string) => store.domains.find((d) => d.id === id);

const asAdmin = { headers: { Authorization: `Bearer ${ADMIN_KEY}` } };
const asProjectKey = { headers: { Authorization: `Bearer ${PROJECT_KEY}` } };

interface DomainBody {
  id: string;
  domain: string;
  verifiedAt: string | null;
  recordName: string;
  recordValue: string;
  createdAt: string;
}

interface ErrorBody {
  error: { message: string; type: string };
}

const list = async (): Promise<DomainBody[]> => {
  const res = await app.request("/v1/org/domains", asAdmin);
  expect(res.status).toBe(200);
  return (await res.json()) as DomainBody[];
};

const claim = (body: unknown, init: RequestInit = asAdmin) =>
  app.request("/v1/org/domains", {
    ...init,
    method: "POST",
    body: JSON.stringify(body),
  });

const verify = (id: string, init: RequestInit = asAdmin) =>
  app.request(`/v1/org/domains/${id}/verify`, {
    ...init,
    method: "POST",
    body: JSON.stringify({}),
  });

const remove = (id: string, init: RequestInit = asAdmin) =>
  app.request(`/v1/org/domains/${id}`, { ...init, method: "DELETE" });

const messageOf = async (res: Response) =>
  ((await res.json()) as ErrorBody).error.message;

describe("GET /v1/org/domains", () => {
  it("returns the org's domains with the TXT record to publish", async () => {
    const body = await list();
    expect(body.map((row) => row.id)).toEqual(["d-pending", "d-verified"]);
    expect(body[0]).toEqual({
      id: "d-pending",
      domain: "acme.com",
      verifiedAt: null,
      recordName: "_onecli-challenge.acme.com",
      recordValue: `onecli-domain-verification=${TOKEN}`,
      createdAt: at(10).toISOString(),
    });
    expect(body[1]?.verifiedAt).toBe(at(30).toISOString());
  });

  it("never leaks domains of another organization", async () => {
    const body = await list();
    expect(body.some((row) => row.domain === "rival.com")).toBe(false);
  });

  it("403s a project-scoped key even when its user is an org owner", async () => {
    const res = await app.request("/v1/org/domains", asProjectKey);
    expect(res.status).toBe(403);
  });

  it("403s a non-admin member (deterministic, not a 401)", async () => {
    store.sessionUserId = MEMBER;
    const res = await app.request("/v1/org/domains");
    expect(res.status).toBe(403);
  });

  it("401s an unauthenticated caller", async () => {
    const res = await app.request("/v1/org/domains");
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/org/domains (claim)", () => {
  it("claims a domain as PENDING and audits it", async () => {
    const res = await claim({ domain: "example.com" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DomainBody;
    expect(body).toMatchObject({
      domain: "example.com",
      verifiedAt: null,
      recordName: "_onecli-challenge.example.com",
    });
    // A claim is an assertion until DNS backs it: verifiedAt starts null and
    // only the verify path may ever set it.
    expect(domainRow(body.id)?.verifiedAt).toBeNull();
    expect(body.recordValue).toMatch(
      /^onecli-domain-verification=[0-9a-f]{32}$/,
    );

    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({
      organizationId: ORG,
      userId: ADMIN,
      action: "create",
      service: "domain",
      source: "api",
      metadata: { domainId: body.id, domain: "example.com" },
    });
    // The token is a public DNS value, but it has no business in an audit row.
    expect(JSON.stringify(store.audits[0]?.metadata)).not.toContain(
      body.recordValue.split("=")[1],
    );
  });

  it("mints a distinct token per claim", async () => {
    const first = (await (
      await claim({ domain: "a-corp.com" })
    ).json()) as DomainBody;
    const second = (await (
      await claim({ domain: "b-corp.com" })
    ).json()) as DomainBody;
    expect(first.recordValue).not.toBe(second.recordValue);
  });

  it("normalizes case, the trailing root dot, and unicode before storing", async () => {
    for (const [input, stored] of [
      ["  Example.COM  ", "example.com"],
      ["Example.com.", "example.com"],
      ["münchen.de", "xn--mnchen-3ya.de"],
    ] as const) {
      store.domains = [];
      const res = await claim({ domain: input });
      expect(res.status).toBe(200);
      expect(((await res.json()) as DomainBody).domain).toBe(stored);
    }
  });

  it("422s anything that is not a claimable domain", async () => {
    for (const value of [
      "localhost",
      "app.localhost",
      "127.0.0.1",
      "0x7f.1",
      "com",
      "co.uk",
      "example",
      "https://example.com",
      "user@example.com",
      "example.com/path",
      "exa mple.com",
      "-example.com",
      `${"a".repeat(64)}.com`,
      "",
      "   ",
    ]) {
      const res = await claim({ domain: value });
      expect(res.status, `expected 422 for ${JSON.stringify(value)}`).toBe(422);
    }
    expect(store.audits).toHaveLength(0);
  });

  // Reserved / internal-only names, for the reason `localhost` was always
  // rejected: a self-hosted instance resolves these through whatever local zone
  // its operator points it at, so anyone who can write that zone could mint a
  // "verified" domain they do not own publicly.
  it("422s reserved and internal-only names", async () => {
    for (const value of [
      "printer.local",
      "svc.internal",
      "router.home.arpa",
      "thing.alt",
      "fileserver.lan",
      "nope.invalid",
      "acme.test",
      "docs.example",
      "host.corp",
      "wiki.intranet",
    ]) {
      const res = await claim({ domain: value });
      expect(res.status, `expected 422 for ${value}`).toBe(422);
    }
  });

  // Private registry suffixes: nobody could verify the shared root anyway, but
  // a claim on it is a permanent squat on the GLOBAL unique index, in a
  // namespace thousands of unrelated parties hold subdomains under.
  it("422s a shared public-suffix root while still allowing a subdomain of it", async () => {
    for (const root of [
      "github.io",
      "vercel.app",
      "pages.dev",
      "herokuapp.com",
      "blogspot.com",
    ]) {
      expect((await claim({ domain: root })).status, root).toBe(422);
    }
    const res = await claim({ domain: "acme.github.io" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as DomainBody).domain).toBe("acme.github.io");
  });

  // The cap is on what the CHALLENGE name has to satisfy, not on the domain:
  // a 247-char domain is legal but yields a 265-char query name, which c-ares
  // rejects as EBADNAME without emitting a packet — a resolver-shaped failure
  // for what is really an input-length problem.
  it("caps the domain so the challenge name stays a legal query name", async () => {
    // Exactly `total` characters, in labels short enough to stay legal.
    const nameOfLength = (total: number) => {
      const parts: string[] = [];
      for (let left = total; left > 0; ) {
        const size = Math.min(60, left);
        parts.push("a".repeat(size));
        left -= size + 1; // the joining dot
      }
      return parts.join(".");
    };

    const tooLong = nameOfLength(236);
    expect(tooLong).toHaveLength(236);
    expect((await claim({ domain: tooLong })).status).toBe(422);

    const atCap = nameOfLength(235);
    expect(atCap).toHaveLength(235);
    const res = await claim({ domain: atCap });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DomainBody;
    expect(body.recordName.length).toBeLessThanOrEqual(253);
  });

  // A rate-limit floor, not an inventory rule: the cooldown keys on domain id,
  // so distinct rows never gate each other and an uncapped org could fan out
  // thousands of concurrent outbound lookups through this instance's resolver.
  it("409s past the per-org cap, counting only this org's rows", async () => {
    store.domains = Array.from({ length: 25 }, (_, i) =>
      domain(`d-cap-${i}`, `held-${i}.com`),
    );
    // Another org's rows must not count against this one.
    store.domains.push(
      domain("d-other", "elsewhere.com", { organizationId: OTHER_ORG }),
    );

    const res = await claim({ domain: "one-too-many.com" });
    expect(res.status).toBe(409);
    expect(await messageOf(res)).toContain("at most 25 domains");
    expect(store.audits).toHaveLength(0);

    // Freeing a slot re-opens the door.
    store.domains = store.domains.filter((d) => d.id !== "d-cap-0");
    expect((await claim({ domain: "one-too-many.com" })).status).toBe(200);
  });

  it("422s a missing/unparseable body", async () => {
    const res = await app.request("/v1/org/domains", {
      ...asAdmin,
      method: "POST",
    });
    expect(res.status).toBe(422);
  });

  // THE cross-tenant case. `domain` is unique GLOBALLY, not per-org, so this
  // endpoint could otherwise be walked to enumerate another tenant's holdings.
  it("409s a domain another org holds with a NEUTRAL message", async () => {
    const res = await claim({ domain: "rival.com" });
    expect(res.status).toBe(409);
    const message = await messageOf(res);
    expect(message).toBe(
      "That domain is already claimed. Contact support if it belongs to your organization.",
    );
    // Nothing about the holder — not its id, not its members, not "another
    // organization" as a fact the caller can act on.
    expect(message).not.toContain(OTHER_ORG);
    expect(message.toLowerCase()).not.toContain("another");
    expect(store.audits).toHaveLength(0);
    expect(store.domains.filter((d) => d.domain === "rival.com")).toHaveLength(
      1,
    );
  });

  it("normalizes BEFORE the uniqueness check, so no spelling slips past", async () => {
    const res = await claim({ domain: "RIVAL.com." });
    expect(res.status).toBe(409);
    expect(await messageOf(res)).not.toContain(OTHER_ORG);
  });

  it("409s the caller's OWN domain with a message that says so", async () => {
    const res = await claim({ domain: "acme.com" });
    expect(res.status).toBe(409);
    // Same-org: naming it leaks nothing the caller can't already list.
    expect(await messageOf(res)).toBe("You have already claimed this domain.");
  });

  it("409s a claim-claim race surfaced as P2002, neutrally", async () => {
    store.race = true;
    const res = await claim({ domain: "rival.com" });
    expect(res.status).toBe(409);
    // The racing claimant is unknown here, so the message must be the neutral
    // one — it may well belong to another organization.
    expect(await messageOf(res)).toContain("already claimed");
    expect(await messageOf(await claim({ domain: "rival.com" }))).not.toContain(
      OTHER_ORG,
    );
    expect(store.audits).toHaveLength(0);
  });

  it("403s a project-scoped key and claims/audits nothing", async () => {
    const res = await claim({ domain: "example.com" }, asProjectKey);
    expect(res.status).toBe(403);
    expect(store.domains.some((d) => d.domain === "example.com")).toBe(false);
    expect(store.audits).toHaveLength(0);
  });

  it("403s a non-admin member", async () => {
    store.sessionUserId = MEMBER;
    const res = await claim({ domain: "example.com" }, {});
    expect(res.status).toBe(403);
    expect(store.audits).toHaveLength(0);
  });
});

describe("POST /v1/org/domains/:domainId/verify", () => {
  const published = (value: string) => [[value]];

  it("verifies on a matching TXT record and audits the change", async () => {
    dns.resolveTxt.mockResolvedValue(
      published(`onecli-domain-verification=${TOKEN}`),
    );

    const res = await verify("d-pending");
    expect(res.status).toBe(200);
    const body = (await res.json()) as DomainBody;
    expect(body.verifiedAt).not.toBeNull();
    expect(domainRow("d-pending")?.verifiedAt).toBeInstanceOf(Date);

    expect(dns.resolveTxt).toHaveBeenCalledWith("_onecli-challenge.acme.com");
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({
      action: "update",
      service: "domain",
      source: "api",
      metadata: {
        domainId: "d-pending",
        domain: "acme.com",
        change: "verified",
      },
    });
  });

  it("joins the 255-octet chunks of one record before comparing", async () => {
    const value = `onecli-domain-verification=${TOKEN}`;
    dns.resolveTxt.mockResolvedValue([
      ["unrelated=1"],
      [value.slice(0, 10), value.slice(10)],
    ]);
    const res = await verify("d-pending");
    expect(res.status).toBe(200);
    expect(domainRow("d-pending")?.verifiedAt).toBeInstanceOf(Date);
  });

  // Some DNS panels normalize the case of a stored TXT value. The token is
  // hex, so case carries no entropy — without this a correct record would
  // read as permanently missing.
  it("matches a record an uppercasing provider stored", async () => {
    dns.resolveTxt.mockResolvedValue(
      published(`ONECLI-DOMAIN-VERIFICATION=${TOKEN.toUpperCase()}`),
    );
    expect((await verify("d-pending")).status).toBe(200);
    expect(domainRow("d-pending")?.verifiedAt).toBeInstanceOf(Date);
  });

  it("MISSES on records that don't carry the token, leaving the row untouched", async () => {
    dns.resolveTxt.mockResolvedValue([
      ["v=spf1 -all"],
      ["onecli-domain-verification=someone-elses-token"],
    ]);

    const res = await verify("d-pending");
    expect(res.status).toBe(400);
    expect(await messageOf(res)).toBe(
      "No matching TXT record found at _onecli-challenge.acme.com. DNS changes can take up to an hour to propagate.",
    );
    // No `failed` marker, no timestamp, no audit — a miss is the outcome of a
    // CHECK, not a change to the domain.
    expect(domainRow("d-pending")?.verifiedAt).toBeNull();
    expect(store.audits).toHaveLength(0);
  });

  // `EBADNAME` sits here, not with the resolver failures: c-ares refuses to
  // emit the query because the NAME is malformed, which is an input problem.
  // Reporting it as unreachable DNS would send an operator to audit healthy
  // egress over a client-side defect. (`NXDOMAIN` is deliberately not covered —
  // c-ares surfaces that condition as `ENOTFOUND` and Node never emits the
  // string, so a case for it would be testing a constant, not the code.)
  it("reports ENOTFOUND / ENODATA / EBADNAME as claimant-side, not a server fault", async () => {
    for (const code of ["ENOTFOUND", "ENODATA", "EBADNAME"]) {
      clock += 60_000;
      dns.resolveTxt.mockRejectedValue(
        Object.assign(new Error(code), { code }),
      );
      const res = await verify("d-pending");
      expect(res.status).toBe(400);
      expect(await messageOf(res)).toContain("can take up to an hour");
      expect(domainRow("d-pending")?.verifiedAt).toBeNull();
    }
  });

  it("reports ESERVFAIL as an INSTANCE-side DNS problem", async () => {
    // The distinction self-hosted operators need: telling them to wait for
    // propagation would send them chasing a record that is already published.
    for (const code of ["ESERVFAIL", "ECONNREFUSED", "EAI_AGAIN"]) {
      clock += 60_000;
      dns.resolveTxt.mockRejectedValue(
        Object.assign(new Error(code), { code }),
      );
      const res = await verify("d-pending");
      expect(res.status).toBe(400);
      expect(await messageOf(res)).toBe(
        "Couldn't reach DNS from this instance. Check the server's outbound DNS and try again.",
      );
    }
  });

  it("gives up on a hung resolver and reports it as unreachable", async () => {
    // Node's resolver has no built-in deadline, so the service races one.
    dns.resolveTxt.mockImplementation(() => new Promise(() => {}));
    const res = await verify("d-pending");
    expect(res.status).toBe(400);
    expect(await messageOf(res)).toContain("Couldn't reach DNS");
    expect(domainRow("d-pending")?.verifiedAt).toBeNull();
  }, 10_000);

  it("rejects a re-check inside the cooldown window", async () => {
    dns.resolveTxt.mockResolvedValue([["nope"]]);
    expect((await verify("d-pending")).status).toBe(400);

    // Same instant: inside the ~10s floor.
    const res = await verify("d-pending");
    expect(res.status).toBe(409);
    expect(await messageOf(res)).toContain("Wait a few seconds");
    expect(dns.resolveTxt).toHaveBeenCalledTimes(1);

    // Past the window, the check runs again.
    clock += 60_000;
    expect((await verify("d-pending")).status).toBe(400);
    expect(dns.resolveTxt).toHaveBeenCalledTimes(2);
  });

  // A re-check of a verified row is a READ: no lookup, no write, no audit.
  // Auditing it would let a double-click or a polling client stack N events all
  // claiming the domain was verified, every one carrying the SAME original
  // timestamp — an operator could no longer identify the real
  // proof-of-ownership moment, and the row count would be unbounded for a call
  // that costs no DNS.
  it("is a no-op 200 on an already-verified domain — no DNS, NO AUDIT", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await verify("d-verified");
      expect(res.status).toBe(200);
      expect(((await res.json()) as DomainBody).verifiedAt).toBe(
        at(30).toISOString(),
      );
    }
    expect(dns.resolveTxt).not.toHaveBeenCalled();
    expect(store.audits).toHaveLength(0);
    // And the original timestamp is still the original.
    expect(domainRow("d-verified")?.verifiedAt).toEqual(at(30));
  });

  it("404s an unknown domain and a domain of another org (cross-org isolation)", async () => {
    expect((await verify("d-nope")).status).toBe(404);
    const res = await verify("d-foreign");
    expect(res.status).toBe(404);
    expect(domainRow("d-foreign")?.verifiedAt).toBeNull();
    expect(dns.resolveTxt).not.toHaveBeenCalled();
  });

  it("403s a project-scoped key and a non-admin", async () => {
    dns.resolveTxt.mockResolvedValue(
      published(`onecli-domain-verification=${TOKEN}`),
    );
    expect((await verify("d-pending", asProjectKey)).status).toBe(403);
    store.sessionUserId = MEMBER;
    expect((await verify("d-pending", {})).status).toBe(403);
    expect(domainRow("d-pending")?.verifiedAt).toBeNull();
    expect(store.audits).toHaveLength(0);
  });
});

describe("DELETE /v1/org/domains/:domainId", () => {
  it("releases a claim and audits whether it was verified", async () => {
    const res = await remove("d-verified");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "d-verified",
      domain: "acme-verified.com",
      verified: true,
    });
    expect(domainRow("d-verified")).toBeUndefined();
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({
      action: "delete",
      service: "domain",
      metadata: {
        domainId: "d-verified",
        domain: "acme-verified.com",
        verified: true,
      },
    });
  });

  it("reports a pending row as unverified", async () => {
    const res = await remove("d-pending");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ verified: false });
  });

  it("frees the name for a fresh claim, token and all", async () => {
    expect((await remove("d-pending")).status).toBe(200);
    const res = await claim({ domain: "acme.com" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DomainBody;
    expect(body.verifiedAt).toBeNull();
    expect(body.recordValue).not.toBe(`onecli-domain-verification=${TOKEN}`);
  });

  it("404s an unknown domain and a domain of another org", async () => {
    expect((await remove("d-nope")).status).toBe(404);
    expect((await remove("d-foreign")).status).toBe(404);
    expect(domainRow("d-foreign")).toBeTruthy();
    expect(store.audits).toHaveLength(0);
  });

  it("403s a project-scoped key and deletes nothing", async () => {
    const res = await remove("d-pending", asProjectKey);
    expect(res.status).toBe(403);
    expect(domainRow("d-pending")).toBeTruthy();
    expect(store.audits).toHaveLength(0);
  });
});
