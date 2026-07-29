import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAuthMode } from "@/lib/auth/auth-mode";
import { getServerSession } from "@/lib/auth/server";
import { describeInvitation } from "@onecli/api/services/org-invitation-service";
import { JoinCard } from "./_components/join-card";

// D-E: the token lives in the URL path, so this page must never leak it —
// no-referrer, and the page renders no external links.
export const metadata: Metadata = {
  title: "Join",
  referrer: "no-referrer",
};

// Next 16 async params.
interface Props {
  params: Promise<{ token: string }>;
}

/**
 * The invitation landing page. Deliberately OUTSIDE `(dashboard)`: that
 * layout's `/v1/auth/session` call is the only org-bootstrap trigger, and
 * placing /join inside it would guarantee the bootstrap-vs-accept race. A
 * server component with an explicit Join button — never a side-effecting GET
 * (prefetchers and link unfurlers hit invite links).
 */
export default async function JoinPage({ params }: Props) {
  // Local mode has exactly one built-in identity — invitations don't exist.
  if (getAuthMode() === "local") notFound();

  const { token } = await params;
  const session = await getServerSession();
  const view = await describeInvitation(
    token,
    // `session.id` is the EXTERNAL auth id — describeInvitation resolves the
    // DB user itself (and never creates one during a GET render).
    session ? { externalAuthId: session.id, email: session.email } : null,
  );

  return (
    <div className="bg-muted/20 flex min-h-svh items-center justify-center p-6">
      <JoinCard view={view} token={token} />
    </div>
  );
}
