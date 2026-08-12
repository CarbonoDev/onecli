import { TriangleAlert } from "lucide-react";
import { Card } from "@onecli/ui/components/card";

export interface InvitationsErrorNoticeProps {
  /**
   * A refetch failed while an earlier result is still on screen. React Query
   * keeps the last successful `data`, so the invited rows ARE rendered — the
   * notice must not claim they are missing, only that they may have aged.
   */
  stale?: boolean;
}

/**
 * The invitations fetch failed. It degrades to an inline notice next to the
 * members table — never a page-level error (the members list loaded fine) and
 * never silence (an empty invitations list and a failed one must not look the
 * same).
 */
export const InvitationsErrorNotice = ({
  stale = false,
}: InvitationsErrorNoticeProps) => (
  <Card className="flex-row items-start gap-2 p-4">
    <TriangleAlert className="text-destructive mt-0.5 size-4 shrink-0" />
    <div>
      <p className="text-sm font-medium">Couldn&apos;t load invitations</p>
      <p className="text-muted-foreground mt-1 text-xs">
        {stale
          ? "The invitations above are from the last successful load and may be out of date. Refresh the page to try again."
          : "The member list above is complete, but pending invitations couldn't be fetched, so any invited people are missing from it. Refresh the page to try again."}
      </p>
    </div>
  </Card>
);
