import type { InvitationView } from "@onecli/api/services/org-invitation-service";

export interface InviteSummaryProps {
  /** Only the states that carry the full summary fields render this block. */
  view: Extract<
    InvitationView,
    { state: "signin-required" | "ready" | "other-org" }
  >;
}

/** Inviter / invited address / role summary shown on the join card. */
export const InviteSummary = ({ view }: InviteSummaryProps) => (
  <dl className="space-y-2 text-sm">
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">Invited by</dt>
      <dd className="truncate font-medium">{view.invitedByEmail}</dd>
    </div>
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">Invited address</dt>
      <dd className="truncate font-medium">{view.invitedEmail}</dd>
    </div>
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">Role</dt>
      <dd className="font-medium capitalize">{view.role}</dd>
    </div>
  </dl>
);
