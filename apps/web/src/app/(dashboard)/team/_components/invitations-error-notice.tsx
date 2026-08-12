import { TriangleAlert } from "lucide-react";
import { Card } from "@onecli/ui/components/card";

/**
 * The invitations fetch failed. It degrades to an inline notice next to the
 * members table — never a page-level error (the members list loaded fine) and
 * never silence (an empty invitations list and a failed one must not look the
 * same).
 */
export const InvitationsErrorNotice = () => (
  <Card className="flex-row items-start gap-2 p-4">
    <TriangleAlert className="text-destructive mt-0.5 size-4 shrink-0" />
    <div>
      <p className="text-sm font-medium">Couldn&apos;t load invitations</p>
      <p className="text-muted-foreground mt-1 text-xs">
        The member list above is complete, but pending invitations couldn&apos;t
        be fetched, so any invited people are missing from it. Refresh the page
        to try again.
      </p>
    </div>
  </Card>
);
