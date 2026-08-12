import { z } from "zod";
import {
  DIRECTORY_LIMIT_DEFAULT,
  DIRECTORY_LIMIT_MAX,
  DIRECTORY_LIMIT_MIN,
} from "../lib/cursor";

// Validation for the `/v1/org/*` directory surface. Query strings arrive as
// raw strings (`c.req.query()`), so `limit` is coerced; everything else is
// optional and bounded.

/** The list-query contract every directory-scale list shares. */
export const directoryListQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(DIRECTORY_LIMIT_MIN)
    .max(DIRECTORY_LIMIT_MAX)
    .default(DIRECTORY_LIMIT_DEFAULT),
  /** Opaque page cursor — echoed back from a previous page's `nextCursor`. */
  cursor: z.string().optional(),
  /** Free-text filter (case-insensitive substring over the row's identity). */
  q: z.string().max(200).optional(),
});

export type DirectoryListQuery = z.infer<typeof directoryListQuerySchema>;

/**
 * Organization display name — trimmed, 1–255 chars (the bounds
 * `validateOrgName` has always enforced service-side). Deliberately NOT unique
 * across organizations, for the same reason as `projectNameSchema`: two
 * unrelated tenants may legitimately call themselves the same thing, and the
 * identity that must stay unique is the immutable `slug`, not the label.
 */
export const orgNameSchema = z.string().trim().min(1).max(255);

export const renameOrganizationSchema = z.object({ name: orgNameSchema });

export const orgMemberStatusSchema = z.enum(["active", "suspended"]);

/** Assignable member roles: `owner` is not assignable through this surface. */
export const orgMemberRoleSchema = z.enum(["admin", "member"]);

export const orgMemberListQuerySchema = directoryListQuerySchema.extend({
  status: orgMemberStatusSchema.optional(),
});

export type OrgMemberListQuery = z.infer<typeof orgMemberListQuerySchema>;

export const invitationStatusSchema = z.enum([
  "pending",
  "accepted",
  "cancelled",
  "expired",
]);

export const invitationListQuerySchema = directoryListQuerySchema.extend({
  status: invitationStatusSchema.optional(),
});

export type InvitationListQuery = z.infer<typeof invitationListQuerySchema>;

/**
 * `POST /v1/org/invitations` body. The email is trimmed and lowercased BEFORE
 * the format check: the stored value is the accept-time match key (accept
 * compares the visitor's session email against it case-insensitively), so the
 * normalization must happen at the door, not per comparison site.
 */
export const createInvitationSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(255)),
  role: orgMemberRoleSchema,
  /**
   * The project the invitee is attached to on accept. Optional: omit it and
   * they land on the organization's oldest project. The service rejects an id
   * outside the organization, so this is not a channel for reaching another
   * org's project.
   */
  projectId: z.string().min(1).optional(),
});

export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

// ── Groups ────────────────────────────────────────────────────────────────

/**
 * Group provenance — a READ-side filter only. `source` is never accepted on a
 * write: creates hard-code `"manual"`, and `"scim"` rows (IdP-provisioned in
 * EE) reject every mutation with 409 so the dashboard can never fight the
 * IdP over ownership of a provisioned group.
 */
export const groupSourceSchema = z.enum(["manual", "scim"]);

/** Group display name — trimmed, 1–100 chars. */
export const groupNameSchema = z.string().trim().min(1).max(100);

/**
 * Replace-set ceiling for a single group's membership. Deliberately NOT
 * `DIRECTORY_LIMIT_MAX` (a page-size bound, 200): the members dialog drains
 * every page and PUTs the full set back, so the write cap must comfortably
 * exceed one page while still bounding the request body.
 */
export const MAX_GROUP_MEMBERS = 1000;

export const groupListQuerySchema = directoryListQuerySchema.extend({
  source: groupSourceSchema.optional(),
});

export type GroupListQuery = z.infer<typeof groupListQuerySchema>;

/** Body `source`/`externalId` are ignored by construction: not in the schema. */
export const createGroupSchema = z.object({ name: groupNameSchema });

export const renameGroupSchema = z.object({ name: groupNameSchema });

export const setGroupMembersSchema = z.object({
  userIds: z.array(z.string().min(1)).max(MAX_GROUP_MEMBERS),
});

// ── Role mappings ────────────────────────────────────────────────────────

/**
 * Ceiling on the org's mapping set — enforced on BOTH ends, and it has to be:
 * `PUT /order` takes the FULL ordered id set, so an org that can hold more
 * mappings than this body allows would have an unreachable reorder endpoint
 * (every honest body 422s on `.max()`, every shorter one 409s on the
 * names-every-mapping-once check) and no way to resolve shadowing. The chosen
 * invariant is therefore `mappings ≤ MAX_ROLE_MAPPINGS`: `createOrgRoleMapping`
 * 409s at the cap, so the reorder body can always name the whole set.
 */
export const MAX_ROLE_MAPPINGS = 500;

/**
 * Mappings assign exactly the roles the members surface can — never `owner`.
 * Owner is bootstrap-only, and `updateOrgMemberRole` already refuses to assign
 * or overwrite it, so a body carrying `role: "owner"` is a 422 here rather
 * than a privilege the mapping engine could mint.
 */
export const roleMappingRoleSchema = orgMemberRoleSchema;

/**
 * `priority` is an ASCENDING rank: 0 = highest precedence (evaluated first /
 * wins). Omitted on create means "append after the current last mapping".
 *
 * NOT coerced, unlike `limit`: this field only ever arrives in a JSON body, so
 * it is already a number when it is one. Coercion would turn `null`, `""`,
 * `false` and `[]` into `0` — the HIGHEST-precedence slot, the single most
 * consequential value the field can take — instead of the 422 a body that
 * meant "no priority" deserves. `.optional()` still short-circuits `undefined`,
 * so the omitted-priority append path is unaffected.
 */
export const roleMappingPrioritySchema = z.number().int().min(0).max(100_000);

export const createRoleMappingSchema = z.object({
  groupId: z.string().min(1),
  role: roleMappingRoleSchema,
  priority: roleMappingPrioritySchema.optional(),
});

export type CreateRoleMappingInput = z.infer<typeof createRoleMappingSchema>;

export const updateRoleMappingSchema = z.object({
  role: roleMappingRoleSchema,
  priority: roleMappingPrioritySchema.optional(),
});

export type UpdateRoleMappingInput = z.infer<typeof updateRoleMappingSchema>;

/**
 * The FULL ordered id set, index 0 = highest priority. A body that does not
 * name every current mapping exactly once is STALE → 409 in the service (the
 * `reorderPolicyRules` precedent); duplicates are malformed → 422 here.
 *
 * Deliberately NOT `.min(1)` (unlike `reorderPolicyRulesSchema`): an org with
 * zero mappings legitimately reorders to `[]`, and a minimum would 422 that
 * honest no-op.
 */
export const reorderRoleMappingsSchema = z.object({
  orderedIds: z
    .array(z.string().min(1))
    .max(MAX_ROLE_MAPPINGS)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "orderedIds must not contain duplicates.",
    }),
});

/**
 * Dry run. No `priority`: an existing mapping is previewed at its current
 * slot, a new one as if appended last — exactly what the create button does.
 */
export const previewRoleMappingSchema = z.object({
  groupId: z.string().min(1),
  role: roleMappingRoleSchema,
});

export type PreviewRoleMappingInput = z.infer<typeof previewRoleMappingSchema>;

/**
 * `PATCH /v1/org/members/:userId` accepts EXACTLY ONE change per request —
 * either a lifecycle change (`status`) or a role change (`role`). A body
 * carrying both or neither is rejected rather than silently applying one:
 * the two changes have different invariants and different audit metadata, so
 * a combined write would be ambiguous to authorize and to read back.
 */
export type UpdateOrgMemberInput =
  | { status: z.infer<typeof orgMemberStatusSchema> }
  | { role: z.infer<typeof orgMemberRoleSchema> };

export const updateOrgMemberSchema = z
  .object({
    status: orgMemberStatusSchema.optional(),
    role: orgMemberRoleSchema.optional(),
  })
  .transform((body, ctx): UpdateOrgMemberInput => {
    if (body.status !== undefined && body.role === undefined) {
      return { status: body.status };
    }
    if (body.role !== undefined && body.status === undefined) {
      return { role: body.role };
    }
    ctx.addIssue({
      code: "custom",
      message: "Provide exactly one of `status` or `role`.",
    });
    return z.NEVER;
  });
