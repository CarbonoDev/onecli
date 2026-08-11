import { Eye } from "lucide-react";

export interface ReadOnlyNoticeProps {
  /**
   * Who may change this page's settings, and what they can change. Required
   * rather than defaulted: the sentence is the only page-specific part, and a
   * default would quietly ship the wrong resource's wording to a new caller.
   */
  description: string;
}

/**
 * Rendered when the signed-in user may VIEW a settings page but not act on it.
 * Without it the page is a wall of silently disabled controls (the /team and
 * /groups pages surface the same distinction with their admin-only notice).
 *
 * Lives in the shared `settings/_components` — like `settings-nav.tsx` — since
 * both the project and the organization page reach the same read-only state.
 */
export const ReadOnlyNotice = ({ description }: ReadOnlyNoticeProps) => (
  <div className="bg-muted/40 flex items-start gap-3 rounded-lg border p-4">
    <Eye className="text-muted-foreground mt-0.5 size-4 shrink-0" />
    <div>
      <p className="text-sm font-medium">You can view these settings</p>
      <p className="text-muted-foreground mt-1 text-xs">{description}</p>
    </div>
  </div>
);
