"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { acceptInvitationAction } from "@/lib/actions/org-invitations";
import { useSwitchOrganization } from "@/hooks/use-switch-organization";

export interface AcceptInvitationButtonProps {
  token: string;
  organizationName: string;
}

/**
 * EXPLICIT click, never auto-accept on mount: a visitor lured onto an invite
 * link must not be silently joined to someone's organization.
 */
export const AcceptInvitationButton = ({
  token,
  organizationName,
}: AcceptInvitationButtonProps) => {
  const router = useRouter();
  const switchOrganization = useSwitchOrganization();
  const [joining, setJoining] = useState(false);

  const handleJoin = async () => {
    setJoining(true);
    const result = await acceptInvitationAction(token);
    if (result.ok) {
      // Select the org that was just joined, together with the project the
      // accept bound this member to. Without it the dashboard opens on
      // whatever the previous selection resolves to — the visitor's own org
      // for an existing user, and for a brand-new one an org selector with
      // nothing selected: the invitation appears to have done nothing.
      switchOrganization({
        organizationId: result.data.organizationId,
        projectId: result.data.projectId,
      });
      // replace, not push: the tokened URL should not stay in history.
      router.replace("/overview");
      return;
    }
    toast.error(result.error);
    setJoining(false);
  };

  return (
    <Button className="w-full" onClick={handleJoin} disabled={joining}>
      {joining ? (
        <>
          <Loader2 className="size-4 animate-spin" />
          Joining...
        </>
      ) : (
        `Join ${organizationName}`
      )}
    </Button>
  );
};
