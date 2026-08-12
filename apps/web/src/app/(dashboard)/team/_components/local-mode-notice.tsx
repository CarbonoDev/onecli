import { Users } from "lucide-react";
import { EmptyState } from "@/components/empty-state";

/** Local auth mode has exactly one identity — the team surface is inert. */
export const LocalModeNotice = () => (
  <EmptyState
    variant="card"
    icon={Users}
    title="Team is unavailable in local mode"
    description="This instance runs in local auth mode, which has exactly one built-in identity (admin@localhost). To invite teammates, configure Google OAuth (NEXTAUTH_SECRET + GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET) and restart."
  />
);
