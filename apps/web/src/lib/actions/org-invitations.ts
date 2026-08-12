"use server";

// Registers the OSS role resolver for the server-action module graph
// (mirrors resolve-user.ts) — `ensureMemberDefaultProject` runs rbac-gated
// project provisioning downstream of the accept.
import "@/lib/init/server";
import { getAuthMode } from "@/lib/auth/auth-mode";
import { getServerSession } from "@/lib/auth/server";
import { safeAction, type ActionResult } from "@/lib/safe-action";
import {
  acceptInvitation,
  describeInvitation,
  resolveInviteeUser,
} from "@onecli/api/services/org-invitation-service";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
} from "@onecli/api/services/audit-service";

/**
 * Accept an invitation link — the ONLY accept surface (D-G: no HTTP route).
 *
 * Deliberately does NOT use `resolveProjectContext`: the invitee has no
 * project yet, so it would throw. `resolveInviteeUser` creates the DB user
 * row when the visitor is brand-new — this being the invitee's FIRST
 * authenticated write (before any `/v1/auth/session` sync) is what keeps the
 * org bootstrap from racing the accept. `withAudit` (not `recordAuditEvent`)
 * is load-bearing: it also flushes the gateway's org cache. Source stays the
 * default APP — this really is an interactive dashboard action.
 */
export const acceptInvitationAction = async (
  token: string,
): Promise<ActionResult<{ organizationId: string; projectId: string }>> =>
  safeAction(async () => {
    // Mirror the /join page's guard (it notFound()s in local mode): the
    // action must not be invocable with the ambient local identity either.
    if (getAuthMode() === "local") {
      throw new Error("Invitations are not available in local auth mode.");
    }

    const session = await getServerSession();
    if (!session) throw new Error("Not authenticated");

    // Validate BEFORE mutating anything: a failed accept must not mint a DB
    // user row for a brand-new visitor. That row would permanently disqualify
    // the auth-session bootstrap gate (`!existingUser` is read before the
    // upsert) and strand the account on /create-org, which does not exist in
    // OSS. `describeInvitation` never writes — a revoked/expired/bogus token
    // bails out here with the invitee's slate still clean. `acceptInvitation`
    // re-checks every guard authoritatively afterwards; the describe→accept
    // window is milliseconds wide and its failure mode is a re-invite, not an
    // orphaned account.
    const view = await describeInvitation(token, {
      externalAuthId: session.id,
      email: session.email,
    });
    switch (view.state) {
      case "ready":
      case "other-org":
      // already-member implies the DB user row exists (describeInvitation
      // found it), so resolving below creates nothing; accept is idempotent.
      case "already-member":
        break;
      case "not-found":
        throw new Error("Invitation not found.");
      case "wrong-email":
        throw new Error(
          `This invitation was issued to ${view.invitedEmail}, but you are signed in as ${view.viewerEmail}. Sign in with the invited address to join.`,
        );
      case "suspended":
        throw new Error(
          "Your membership in this organization is suspended. Ask an admin to reinstate you — an invitation cannot bypass a suspension.",
        );
      case "expired":
        throw new Error("This invitation has expired.");
      case "revoked":
      case "accepted":
      // signin-required is unreachable with a session; treat it as inactive.
      case "signin-required":
        throw new Error("This invitation is no longer active.");
    }

    const user = await resolveInviteeUser(
      session.id,
      session.email,
      session.name,
    );

    const result = await withAudit(
      // The D-C match compares the SESSION email — the same value
      // `describeInvitation` compared above — so a stale stored email can
      // never make the page say "ready" while the accept 403s naming an
      // address the user isn't signed in with. `user.id` still keys the
      // membership write.
      () => acceptInvitation(token, user.id, session.email),
      (r) => ({
        organizationId: r.organizationId,
        userId: user.id,
        userEmail: session.email,
        action: AUDIT_ACTIONS.CREATE,
        service: AUDIT_SERVICES.MEMBER,
        metadata: {
          invitationId: r.invitationId,
          role: r.role,
          via: "invitation",
        },
      }),
    );

    // Both ids, not just the project: the caller writes them as the selected
    // scope so the dashboard opens in the org that was just joined instead of
    // wherever the visitor's previous selection (or their own org) points.
    return {
      organizationId: result.organizationId,
      projectId: result.projectId,
    };
  });
