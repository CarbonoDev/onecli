import { UsersRound } from "lucide-react";
import { EmptyState } from "@/components/empty-state";

/**
 * Local auth mode has exactly one identity, so groups are inert — there is
 * nobody to group.
 */
export const LocalModeNotice = () => (
  <EmptyState
    variant="card"
    icon={UsersRound}
    title="Groups are unavailable in local mode"
    description="This instance runs in local auth mode, which has exactly one built-in identity (admin@localhost) — there is nobody to group. To invite teammates and group them, configure Google OAuth (NEXTAUTH_SECRET + GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET) and restart."
  />
);
