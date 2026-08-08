import { beforeEach, describe, expect, it, vi } from "vitest";

// The pure resolver behind group→role mappings. No DB mock at all (the
// org-role-resolver.test.ts / policy-target.test.ts precedent): this function
// decides who gets promoted, so a wrong answer here is a privilege escalation
// or a silent demotion. Every decision letter it encodes is pinned below.

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "oss";
});

const warn = vi.hoisted(() => vi.fn());

vi.mock("../lib/logger", () => ({
  logger: { child: () => ({ warn }) },
}));

vi.mock("@onecli/db", () => ({ Prisma: {}, db: {} }));

import {
  resolveRoleMappingChanges,
  type MappingRule,
  type MemberState,
  type RoleChange,
} from "./org-role-mapping-service";

const ACTOR = "user-actor";

const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes));

const rule = (
  id: string,
  groupId: string,
  role: string,
  priority: number,
  createdAt = at(priority),
): MappingRule => ({ id, groupId, role, priority, createdAt });

const member = (userId: string, role: string): MemberState => ({
  userId,
  role,
  userEmail: `${userId}@example.com`,
});

const groups = (entries: Record<string, string[]>) =>
  new Map(Object.entries(entries).map(([g, ids]) => [g, new Set(ids)]));

const resolve = (input: {
  mappings: MappingRule[];
  membersByGroup: Map<string, Set<string>>;
  candidates: MemberState[];
  actorUserId?: string;
}): RoleChange[] =>
  resolveRoleMappingChanges({
    mappings: input.mappings,
    membersByGroup: input.membersByGroup,
    candidates: input.candidates,
    actorUserId: input.actorUserId ?? ACTOR,
  });

beforeEach(() => {
  warn.mockClear();
});

describe("resolveRoleMappingChanges", () => {
  it("returns nothing when the org has no mappings", () => {
    expect(
      resolve({
        mappings: [],
        membersByGroup: groups({ "g-a": ["u-1"] }),
        candidates: [member("u-1", "member")],
      }),
    ).toEqual([]);
  });

  it("raises a member through a single admin mapping", () => {
    const changes = resolve({
      mappings: [rule("rm-1", "g-a", "admin", 0)],
      membersByGroup: groups({ "g-a": ["u-1"] }),
      candidates: [member("u-1", "member")],
    });
    expect(changes).toEqual([
      {
        userId: "u-1",
        userEmail: "u-1@example.com",
        from: "member",
        to: "admin",
        mappingId: "rm-1",
        groupId: "g-a",
      },
    ]);
  });

  it("raises nobody through a member mapping (everyone is already >= member)", () => {
    expect(
      resolve({
        mappings: [rule("rm-1", "g-a", "member", 0)],
        membersByGroup: groups({ "g-a": ["u-1", "u-2"] }),
        candidates: [member("u-1", "member"), member("u-2", "member")],
      }),
    ).toEqual([]);
  });

  it("lets a member mapping at priority 0 SHADOW an admin mapping at priority 1", () => {
    // The load-bearing case: role strength plays no part in picking the
    // winner, only explicit order does (decision A3/C5).
    expect(
      resolve({
        mappings: [
          rule("rm-shadow", "g-everyone", "member", 0),
          rule("rm-eng", "g-eng", "admin", 1),
        ],
        membersByGroup: groups({
          "g-everyone": ["u-1"],
          "g-eng": ["u-1"],
        }),
        candidates: [member("u-1", "member")],
      }),
    ).toEqual([]);
  });

  it("...and reordering the admin mapping to priority 0 raises them", () => {
    const changes = resolve({
      mappings: [
        rule("rm-eng", "g-eng", "admin", 0),
        rule("rm-shadow", "g-everyone", "member", 1),
      ],
      membersByGroup: groups({ "g-everyone": ["u-1"], "g-eng": ["u-1"] }),
      candidates: [member("u-1", "member")],
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ to: "admin", mappingId: "rm-eng" });
  });

  it("breaks a priority tie by createdAt asc, then id asc", () => {
    const older = resolve({
      mappings: [
        rule("rm-b", "g-b", "admin", 0, at(9)),
        rule("rm-a", "g-a", "member", 0, at(5)),
      ],
      membersByGroup: groups({ "g-a": ["u-1"], "g-b": ["u-1"] }),
      candidates: [member("u-1", "member")],
    });
    // rm-a is older, so its `member` wins and nothing is raised.
    expect(older).toEqual([]);

    const sameInstant = resolve({
      mappings: [
        rule("rm-z", "g-b", "admin", 0, at(5)),
        rule("rm-a", "g-a", "member", 0, at(5)),
      ],
      membersByGroup: groups({ "g-a": ["u-1"], "g-b": ["u-1"] }),
      candidates: [member("u-1", "member")],
    });
    // Same instant: id asc decides, and "rm-a" sorts first.
    expect(sameInstant).toEqual([]);
  });

  it("NEVER demotes: an admin under a winning member mapping is untouched", () => {
    expect(
      resolve({
        mappings: [rule("rm-1", "g-a", "member", 0)],
        membersByGroup: groups({ "g-a": ["u-1"] }),
        candidates: [member("u-1", "admin")],
      }),
    ).toEqual([]);
  });

  it("never touches an owner, under either kind of mapping", () => {
    for (const role of ["admin", "member"] as const) {
      expect(
        resolve({
          mappings: [rule("rm-1", "g-a", role, 0)],
          membersByGroup: groups({ "g-a": ["u-owner"] }),
          candidates: [member("u-owner", "owner")],
        }),
      ).toEqual([]);
    }
  });

  it("skips the acting user (mirrors 'you cannot change your own role')", () => {
    expect(
      resolve({
        mappings: [rule("rm-1", "g-a", "admin", 0)],
        membersByGroup: groups({ "g-a": [ACTOR] }),
        candidates: [member(ACTOR, "member")],
      }),
    ).toEqual([]);
  });

  it("skips — and warns about — a current role it does not understand", () => {
    expect(
      resolve({
        mappings: [rule("rm-1", "g-a", "admin", 0)],
        membersByGroup: groups({ "g-a": ["u-1"] }),
        candidates: [member("u-1", "superadmin")],
      }),
    ).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("skips — and warns about — an unrecognized role ON THE MAPPING", () => {
    // Fail closed on the winner rather than falling through to the next
    // mapping, which would grant more than the config says.
    expect(
      resolve({
        mappings: [
          rule("rm-bad", "g-a", "superadmin", 0),
          rule("rm-ok", "g-b", "admin", 1),
        ],
        membersByGroup: groups({ "g-a": ["u-1"], "g-b": ["u-1"] }),
        candidates: [member("u-1", "member")],
      }),
    ).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("leaves a user who is in no mapped group alone", () => {
    expect(
      resolve({
        mappings: [rule("rm-1", "g-a", "admin", 0)],
        membersByGroup: groups({ "g-a": ["u-1"] }),
        candidates: [member("u-1", "member"), member("u-2", "member")],
      }).map((c) => c.userId),
    ).toEqual(["u-1"]);
  });

  it("is idempotent: feeding the result back as current state changes nothing", () => {
    const mappings = [
      rule("rm-1", "g-a", "admin", 0),
      rule("rm-2", "g-b", "member", 1),
    ];
    const membersByGroup = groups({
      "g-a": ["u-1", "u-2"],
      "g-b": ["u-2", "u-3"],
    });
    const candidates = [
      member("u-1", "member"),
      member("u-2", "member"),
      member("u-3", "member"),
    ];

    const first = resolve({ mappings, membersByGroup, candidates });
    expect(first.map((c) => c.userId).sort()).toEqual(["u-1", "u-2"]);

    const applied = candidates.map((c) => {
      const change = first.find((ch) => ch.userId === c.userId);
      return change ? { ...c, role: change.to } : c;
    });
    expect(resolve({ mappings, membersByGroup, candidates: applied })).toEqual(
      [],
    );
  });
});
