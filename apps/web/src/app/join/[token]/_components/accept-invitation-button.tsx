"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { acceptInvitationAction } from "@/lib/actions/org-invitations";

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
  const [joining, setJoining] = useState(false);

  const handleJoin = async () => {
    setJoining(true);
    const result = await acceptInvitationAction(token);
    if (result.ok) {
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
