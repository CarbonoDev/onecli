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
});

export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

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
