import { Lock } from "lucide-react";
import { EmptyState } from "@/components/empty-state";

/**
 * Rendered when the members query 403s — the API is the authority on who is
 * an admin (D-K). A plain card: no retry, no toast (the 403 is deterministic).
 */
export const AdminOnlyNotice = () => (
  <EmptyState
    variant="card"
    icon={Lock}
    title="Admins only"
    description="Managing members and invitations requires an organization admin. Ask an admin if you need someone added to the team."
  />
);
