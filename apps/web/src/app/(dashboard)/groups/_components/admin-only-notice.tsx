import { Lock } from "lucide-react";
import { EmptyState } from "@/components/empty-state";

/**
 * Rendered when the groups query 403s — the API is the authority on who is
 * an admin (the /team D-K pattern). A plain card: no retry, no toast (the
 * 403 is deterministic).
 */
export const AdminOnlyNotice = () => (
  <EmptyState
    variant="card"
    icon={Lock}
    title="Admins only"
    description="Managing groups requires an organization admin. Ask an admin if you need a group created or changed."
  />
);
