import { Users } from "lucide-react";
import { Card } from "@onecli/ui/components/card";

/** Local auth mode has exactly one identity — the team surface is inert. */
export const LocalModeNotice = () => (
  <Card className="flex flex-col items-center justify-center py-16 text-center">
    <div className="bg-muted mb-4 flex size-12 items-center justify-center rounded-full">
      <Users className="text-muted-foreground size-6" />
    </div>
    <p className="text-sm font-medium">Team is unavailable in local mode</p>
    <p className="text-muted-foreground mt-1 max-w-md text-xs">
      This instance runs in local auth mode, which has exactly one built-in
      identity (admin@localhost). To invite teammates, configure Google OAuth
      (NEXTAUTH_SECRET + GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET) and restart.
    </p>
  </Card>
);
