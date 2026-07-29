import { Lock } from "lucide-react";
import { Card } from "@onecli/ui/components/card";

/**
 * Rendered when the groups query 403s — the API is the authority on who is
 * an admin (the /team D-K pattern). A plain card: no retry, no toast (the
 * 403 is deterministic).
 */
export const AdminOnlyNotice = () => (
  <Card className="flex flex-col items-center justify-center py-16 text-center">
    <div className="bg-muted mb-4 flex size-12 items-center justify-center rounded-full">
      <Lock className="text-muted-foreground size-6" />
    </div>
    <p className="text-sm font-medium">Admins only</p>
    <p className="text-muted-foreground mt-1 max-w-xs text-xs">
      Managing groups requires an organization admin. Ask an admin if you need a
      group created or changed.
    </p>
  </Card>
);
