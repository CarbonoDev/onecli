import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Button } from "@onecli/ui/components/button";
import type { InvitationView } from "@onecli/api/services/org-invitation-service";
import { SignInToJoinButton } from "./sign-in-to-join-button";
import { AcceptInvitationButton } from "./accept-invitation-button";
import { InviteSummary } from "./invite-summary";

export interface JoinCardProps {
  view: InvitationView;
  token: string;
}

/**
 * Pure switch over `view.state` — every policy decision was made server-side
 * by `describeInvitation` (D-L). No external links anywhere on this page: the
 * URL path carries the invite token (D-E).
 */
export const JoinCard = ({ view, token }: JoinCardProps) => {
  switch (view.state) {
    case "not-found":
      // Generic on purpose: an unknown token must not be an oracle.
      return (
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Invitation not found</CardTitle>
            <CardDescription>
              This invitation link is not valid. Check that you copied the full
              link, or ask the person who invited you for a new one.
            </CardDescription>
          </CardHeader>
        </Card>
      );

    case "revoked":
      return (
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Invitation revoked</CardTitle>
            <CardDescription>
              Your invitation to {view.organizationName} was revoked. Ask an
              admin to invite you again.
            </CardDescription>
          </CardHeader>
        </Card>
      );

    case "expired":
      return (
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Invitation expired</CardTitle>
            <CardDescription>
              Your invitation to {view.organizationName} has expired (invitation
              links last 7 days). Ask an admin to invite you again.
            </CardDescription>
          </CardHeader>
        </Card>
      );

    case "accepted":
      return (
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Invitation already used</CardTitle>
            <CardDescription>
              This invitation to {view.organizationName} has already been
              accepted. If that wasn&apos;t you, ask an admin to invite you
              again.
            </CardDescription>
          </CardHeader>
        </Card>
      );

    case "already-member":
      return (
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>
              You&apos;re already in {view.organizationName}
            </CardTitle>
            <CardDescription>
              Nothing to do here — your membership is active.
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button asChild className="w-full">
              <Link href="/overview">Go to dashboard</Link>
            </Button>
          </CardFooter>
        </Card>
      );

    case "suspended":
      return (
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Membership suspended</CardTitle>
            <CardDescription>
              Your membership in {view.organizationName} is suspended, and an
              invitation link cannot bypass a suspension. Ask an admin to
              reinstate you.
            </CardDescription>
          </CardHeader>
        </Card>
      );

    case "wrong-email":
      return (
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>This invitation is for someone else</CardTitle>
            <CardDescription>
              The invitation to {view.organizationName} was issued to{" "}
              <strong>{view.invitedEmail}</strong>, but you are signed in as{" "}
              <strong>{view.viewerEmail}</strong>. Sign in with the invited
              address to join.
            </CardDescription>
          </CardHeader>
        </Card>
      );

    case "signin-required":
      return (
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Join {view.organizationName}</CardTitle>
            <CardDescription>
              You&apos;ve been invited to {view.organizationName} on OneCLI.
              Sign in with <strong>{view.invitedEmail}</strong> to accept — the
              invitation only works for that exact address.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <InviteSummary view={view} />
          </CardContent>
          <CardFooter>
            <SignInToJoinButton />
          </CardFooter>
        </Card>
      );

    case "other-org":
    case "ready":
      return (
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Join {view.organizationName}</CardTitle>
            <CardDescription>
              You&apos;ve been invited to {view.organizationName} on OneCLI.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <InviteSummary view={view} />
            {view.state === "other-org" && (
              // D-A: joining works, but the dashboard keeps opening this
              // user's own workspace until org switching ships. Tell the
              // truth up front rather than surprise them after the click.
              <div className="border-amber-500/40 bg-amber-500/10 flex items-start gap-2 rounded-md border p-3 text-xs">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
                <p>
                  You already have your own workspace. You can join{" "}
                  {view.organizationName}, but the dashboard will keep opening
                  your own workspace for now — organization switching is coming
                  later.
                </p>
              </div>
            )}
          </CardContent>
          <CardFooter>
            <AcceptInvitationButton
              token={token}
              organizationName={view.organizationName}
            />
          </CardFooter>
        </Card>
      );
  }
};
