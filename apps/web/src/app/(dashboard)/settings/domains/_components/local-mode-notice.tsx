import { AtSign } from "lucide-react";
import { EmptyState } from "@/components/empty-state";

/**
 * Local auth mode has exactly one identity — `admin@localhost` — and no email
 * domain a DNS record could ever cover, so claiming one is inert.
 */
export const LocalModeNotice = () => (
  <EmptyState
    variant="card"
    icon={AtSign}
    title="Domains are unavailable in local mode"
    description="This instance runs in local auth mode, whose one built-in identity (admin@localhost) belongs to no claimable domain. To claim a company domain, configure Google OAuth (NEXTAUTH_SECRET + GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET) and restart."
  />
);
