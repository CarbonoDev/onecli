/**
 * The house pill marking an integration or capability this build does not
 * implement (`available: false` registry entries, and the locked policy-editor
 * surfaces). Rendered by the Connections list, the policy editor's app
 * pickers, and `ProAppDialog`.
 */
export const UnavailableBadge = () => (
  <span className="border-border bg-muted text-muted-foreground inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium tracking-wide">
    Unavailable
  </span>
);
