import { UsersRound } from "lucide-react";

/**
 * Local auth mode has exactly one built-in identity, so there is nobody to
 * share a project WITH. Rename and delete stay live — only this card degrades.
 */
export const LocalModeNotice = () => (
  <div className="flex flex-col items-center justify-center py-10 text-center">
    <div className="bg-muted mb-3 flex size-10 items-center justify-center rounded-full">
      <UsersRound className="text-muted-foreground size-4" />
    </div>
    <p className="text-sm font-medium">Sharing is unavailable in local mode</p>
    <p className="text-muted-foreground mt-1 max-w-md text-xs">
      This instance runs in local auth mode, which has exactly one built-in
      identity (admin@localhost). To invite teammates and share projects with
      them, configure Google OAuth (NEXTAUTH_SECRET + GOOGLE_CLIENT_ID/
      GOOGLE_CLIENT_SECRET) and restart.
    </p>
  </div>
);
