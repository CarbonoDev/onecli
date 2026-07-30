import { Eye } from "lucide-react";

/**
 * Rendered when the signed-in user may USE this project but not manage it — a
 * member holding a plain use grant. Without it the page is a wall of silently
 * disabled controls (the /team and /groups pages surface the same distinction
 * with their admin-only notice).
 */
export const ReadOnlyNotice = () => (
  <div className="bg-muted/40 flex items-start gap-3 rounded-lg border p-4">
    <Eye className="text-muted-foreground mt-0.5 size-4 shrink-0" />
    <div>
      <p className="text-sm font-medium">You can view these settings</p>
      <p className="text-muted-foreground mt-1 text-xs">
        Only a project owner or an organization admin can rename this project,
        change who can use it, or delete it.
      </p>
    </div>
  </div>
);
