import { z } from "zod";

// Validation for the `/v1/projects/*` surface (rename + the access replace-set).
// Mirrors `validations/org.ts` in shape; kept separate because projects are a
// project-scoped resource, not part of the org directory.

/**
 * Project display name. Bounded like a group name, but deliberately NOT unique
 * per organization: `ensureMemberDefaultProject` names EVERY invited member's
 * project "Default", so a uniqueness rule would 409 the most common state in
 * the product.
 */
export const projectNameSchema = z.string().trim().min(1).max(100);

export const renameProjectSchema = z.object({ name: projectNameSchema });

/**
 * The management role on a USER binding (step 13c): "owner" may
 * rename/share/delete the project, "member" is a plain use grant. GROUP
 * bindings carry no role in v1 — they are always written as "member".
 */
export const projectAccessRoleSchema = z.enum(["owner", "member"]);

/**
 * Replace-set ceilings. Deliberately not `DIRECTORY_LIMIT_MAX` (a page size):
 * the sharing dialog drains every page of the org directory and PUTs the full
 * set back, so the write cap must comfortably exceed one page while still
 * bounding the request body.
 */
export const MAX_PROJECT_ACCESS_USERS = 1000;
export const MAX_PROJECT_ACCESS_GROUPS = 200;

/**
 * `PUT /v1/projects/:projectId/access` body. Both keys are REQUIRED (no
 * `.default([])`): a client bug that omits one must be a 422, never a silent
 * half-wipe of the project's bindings.
 */
export const setProjectAccessSchema = z
  .object({
    users: z
      .array(
        z.object({
          userId: z.string().min(1),
          role: projectAccessRoleSchema,
        }),
      )
      .max(MAX_PROJECT_ACCESS_USERS),
    groupIds: z.array(z.string().min(1)).max(MAX_PROJECT_ACCESS_GROUPS),
  })
  .superRefine((body, ctx) => {
    // A duplicate userId is REJECTED rather than resolved "last wins": each
    // entry carries a role, so a repeat with a conflicting role is genuinely
    // ambiguous. `groupIds` carry no role and are deduped silently in the
    // service (the setOrgGroupMembers precedent).
    const seen = new Set<string>();
    for (const user of body.users) {
      if (seen.has(user.userId)) {
        ctx.addIssue({
          code: "custom",
          message: "Duplicate user in the access set.",
        });
        return;
      }
      seen.add(user.userId);
    }
  });

export type SetProjectAccessInput = z.infer<typeof setProjectAccessSchema>;
