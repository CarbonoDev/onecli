import {
  Activity,
  AtSign,
  Bot,
  Building2,
  Cable,
  ChartNoAxesColumn,
  ChevronLeft,
  Download,
  Fingerprint,
  FolderKanban,
  Globe,
  KeyRound,
  LayoutDashboard,
  Plug,
  Settings,
  ShieldCheck,
  User,
  Users,
  UsersRound,
} from "lucide-react";
import type { NavItem } from "@/app/(dashboard)/_components/nav-main";

export interface SettingsNavItem {
  title: string;
  url: string;
  icon: React.ComponentType<{ className?: string }>;
}

export interface SettingsNavSection {
  label: string;
  items: SettingsNavItem[];
}

/**
 * Which sidebar the current page belongs to. Organization scope (projects,
 * members, org-wide policy and connections) and project scope (the agents,
 * install flow, and activity of one project) are two distinct shells; entering
 * a project replaces the nav list rather than adding to it.
 */
export type NavShell = "org" | "project";

/**
 * Is `pathname` that item's URL, or below it? A bare `startsWith` would light
 * `/policy` up for `/policy-drafts`, so the match has to stop at a segment
 * boundary. Shared by `resolveNavShell` and `NavMain`'s active check so "is
 * this page under that nav item" has exactly one definition.
 */
export const isPathUnderNavItem = (pathname: string, url: string): boolean =>
  pathname === url || pathname.startsWith(`${url}/`);

/**
 * Org-scope navigation, split into two groups: resources and policy first,
 * then administration. `NavItem[][]` rather than a flat list because `NavMain`
 * already renders a `SidebarSeparator` between groups.
 */
export const orgNavItems: NavItem[][] = [
  [
    // Always visible (D-J): the page itself degrades — a member sees only
    // their bound projects and the API's 403 is the authority on any mutation.
    { title: "Projects", url: "/projects", icon: FolderKanban },
    { title: "Global Connections", url: "/global-connections", icon: Cable },
    // Always visible: the organization policy surface degrades for non-admins
    // (the API's 403 is the authority), so hiding it would require a session
    // role field. Org rules are the guardrails every project is evaluated
    // against.
    { title: "Global Policy", url: "/policy", icon: ShieldCheck },
  ],
  [
    // Always visible (D-J): the page itself degrades for non-admins and in
    // local auth mode — hiding the item would require a session role field.
    // Labelled "Members"; the route stays `/team` so existing links and
    // bookmarks keep working.
    { title: "Members", url: "/team", icon: Users },
    // Always visible (D-J): the page itself degrades for non-admins and gates
    // groups in local auth mode — hiding the item would require a session role
    // field.
    { title: "Groups", url: "/groups", icon: UsersRound },
    { title: "Usage", url: "/usage", icon: ChartNoAxesColumn },
    // Always visible: the page degrades for non-admins (the API's 403 is the
    // authority), so hiding it would require a session role field.
    {
      title: "Organization Settings",
      url: "/settings/organization",
      icon: Settings,
    },
  ],
];

/** Project-scope navigation. Flat — one group, no separator. */
export const projectNavItems: NavItem[] = [
  { title: "Overview", url: "/overview", icon: LayoutDashboard },
  { title: "Install", url: "/install", icon: Download },
  { title: "Agents", url: "/agents", icon: Bot },
  { title: "Connections", url: "/connections", icon: Plug },
  { title: "Activity", url: "/activity", icon: Activity },
  { title: "Project Settings", url: "/settings/project", icon: Settings },
];

/** The escape hatch out of project scope, pinned above the project nav list. */
export const projectBackLink: NavItem = {
  title: "All projects",
  url: "/projects",
  icon: ChevronLeft,
};

/** `orgNavItems` without its group structure. Hoisted rather than flattened
 * per call — `resolveNavShell` runs on every sidebar and header render. */
const flatOrgNavItems: NavItem[] = orgNavItems.flat();

/**
 * Which shell `pathname` belongs to.
 *
 * Read off the route table: the path is matched against both nav lists and the
 * LONGEST match wins — that is what separates `/settings/project` from
 * `/settings/organization`. Anything in neither list (`/settings/profile`,
 * `/account/*`, a 404) falls back to the org shell, which is the default
 * scope.
 *
 * Paths only, no `/org/<id>` or `/p/<id>` prefixes: `proxy.ts` REDIRECTS those
 * away on this edition, so `usePathname()` never sees one. Handling them here
 * would be a branch nothing can reach, and a misleading one — the sidebar
 * still emits bare hrefs and the header still matches bare urls, so a
 * half-supported prefix would break both.
 *
 * Deliberately NOT `hasProjectContext()`: that answers "does the gateway
 * resolve a project for this request", which is `true` for every path here —
 * it would put `/team` and `/groups` in the project shell.
 *
 * A new page with no nav entry lands in the org shell by default. Add it to
 * one of the lists above rather than special-casing it here.
 */
export const resolveNavShell = (pathname: string): NavShell => {
  let best: { shell: NavShell; length: number } | undefined;
  const consider = (items: NavItem[], shell: NavShell) => {
    for (const item of items) {
      if (!isPathUnderNavItem(pathname, item.url)) continue;
      if (!best || item.url.length > best.length) {
        best = { shell, length: item.url.length };
      }
    }
  };
  consider(projectNavItems, "project");
  consider(flatOrgNavItems, "org");

  return best?.shell ?? "org";
};

/** The shell's nav items, flattened — for lookups rather than rendering. */
export const navItemsForShell = (shell: NavShell): NavItem[] =>
  shell === "project" ? projectNavItems : flatOrgNavItems;

export const getSettingsSections = (
  // The EE org-UI override uses orgId to prefix URLs with /org/<id>
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  orgId?: string,
): SettingsNavSection[] => [
  {
    label: "General",
    items: [
      // Project first: it is the thing users manage; the instance is operator
      // config. `settings/page.tsx` redirects `/settings` to this first entry,
      // so the order is load-bearing. Bare paths, no /org/<id> prefix —
      // orgScopedUI stays false.
      { title: "Project", url: "/settings/project", icon: FolderKanban },
      // Always visible: the page degrades for non-admins (the API's 403 is the
      // authority), so hiding it would require a session role field.
      {
        title: "Organization",
        url: "/settings/organization",
        icon: Building2,
      },
      { title: "Instance", url: "/settings/instance", icon: Globe },
    ],
  },
  {
    label: "Account",
    items: [
      { title: "Profile", url: "/settings/profile", icon: User },
      { title: "API Keys", url: "/settings/api-keys", icon: KeyRound },
    ],
  },
  {
    label: "Security",
    items: [
      // Domains before single sign-on: verifying a domain is the prerequisite
      // for it. `AtSign` rather than the globe these are usually drawn with,
      // because `Globe` already means Instance one section up.
      { title: "Domains", url: "/settings/domains", icon: AtSign },
      { title: "Single sign-on", url: "/settings/sso", icon: Fingerprint },
      { title: "Encryption", url: "/settings/encryption", icon: ShieldCheck },
    ],
  },
];

export const settingsSections = getSettingsSections();

/**
 * Breadcrumb labels that differ from the nav label for the same URL. The
 * sidebar entry reads "Projects" (a section), the crumb reads "All projects"
 * (the escape hatch back to it).
 */
const NAV_BREADCRUMB_OVERRIDES: Record<string, string> = {
  "/projects": "All projects",
};

// Later entries win. The settings sub-nav sits after the two nav lists on
// purpose: where both name the same url the sidebar says "Project Settings"
// (it has no other context) while the crumb is already under `Settings ›`, so
// the sub-nav's "Project" is the one that reads correctly there.
const NAV_BREADCRUMB_LABELS: Record<string, string> = {
  ...Object.fromEntries(
    [
      ...flatOrgNavItems,
      ...projectNavItems,
      ...settingsSections.flatMap((section) => section.items),
    ].map((item) => [item.url, item.title]),
  ),
  ...NAV_BREADCRUMB_OVERRIDES,
};

/**
 * The human label for an exact dashboard path, or `undefined` when nothing
 * owns it. Lets the breadcrumb reuse the titles the nav already declares
 * instead of title-casing the raw slug — which is what rendered `/settings/
 * api-keys` as "Api keys" while the page itself said "API Keys".
 */
export const navBreadcrumbLabel = (path: string): string | undefined =>
  NAV_BREADCRUMB_LABELS[path];
