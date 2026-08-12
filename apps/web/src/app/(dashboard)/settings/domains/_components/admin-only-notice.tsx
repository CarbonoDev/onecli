import { Lock } from "lucide-react";
import { EmptyState } from "@/components/empty-state";

/**
 * Rendered when the domains query 403s — the API is the authority on who is an
 * admin (the /groups precedent). A plain card: no retry, no toast (the 403 is
 * deterministic).
 */
export const AdminOnlyNotice = () => (
  <EmptyState
    variant="card"
    icon={Lock}
    title="Admins only"
    description="Claiming and verifying domains requires an organization admin. Ask an admin if you need a domain added."
  />
);
