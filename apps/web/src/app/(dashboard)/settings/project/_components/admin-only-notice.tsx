import { Lock } from "lucide-react";

/**
 * Rendered inside the sharing dialog when the candidate directories 403.
 * `/v1/org/members` and `/v1/org/groups` are admin-only, so a project owner who
 * is not an org admin can still SEE and prune the current bindings — they just
 * cannot enumerate who else exists to add. The API is the authority; this is
 * what its deterministic 403 looks like.
 */
export const AdminOnlyNotice = () => (
  <div className="flex flex-col items-center justify-center py-10 text-center">
    <div className="bg-muted mb-3 flex size-10 items-center justify-center rounded-full">
      <Lock className="text-muted-foreground size-4" />
    </div>
    <p className="text-sm font-medium">Admins only</p>
    <p className="text-muted-foreground mt-1 max-w-xs text-xs">
      Browsing the organization&apos;s members and groups requires an admin. Ask
      an admin to share this project, or remove existing access from the list
      behind this dialog.
    </p>
  </div>
);
