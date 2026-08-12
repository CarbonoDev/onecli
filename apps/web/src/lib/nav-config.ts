import {
  LayoutDashboard,
  Download,
  Bot,
  Settings,
  Plug,
  Activity,
  FolderKanban,
  User,
  Users,
  UsersRound,
  KeyRound,
  ShieldCheck,
  Globe,
  Building2,
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

export const navItems: NavItem[] = [
  { title: "Overview", url: "/overview", icon: LayoutDashboard },
  { title: "Install", url: "/install", icon: Download },
  { title: "Agents", url: "/agents", icon: Bot },
  { title: "Connections", url: "/connections", icon: Plug },
  // Always visible: the organization policy surface degrades for non-admins
  // (the API's 403 is the authority), so hiding it would require a session role
  // field. Org rules are the guardrails every project is evaluated against.
  { title: "Policy", url: "/policy", icon: ShieldCheck },
  { title: "Activity", url: "/activity", icon: Activity },
  // Always visible (D-J): the page itself degrades for non-admins and in
  // local auth mode — hiding the item would require a session role field.
  { title: "Team", url: "/team", icon: Users },
  // Always visible (D-J): the page itself degrades for non-admins and gates
  // groups in local auth mode — hiding the item would require a session role
  // field.
  { title: "Groups", url: "/groups", icon: UsersRound },
  // Always visible (D-J): the page itself degrades — a member sees only their
  // bound projects and the API's 403 is the authority on any mutation.
  { title: "Projects", url: "/projects", icon: FolderKanban },
  { title: "Settings", url: "/settings", icon: Settings },
];

export const getSettingsSections = (
  // The EE org-UI override uses orgId to prefix URLs with /org/<id>
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  orgId?: string,
): SettingsNavSection[] => [
  {
    label: "General",
    items: [
      // Project first: it is the thing users manage; the instance is operator
      // config. Bare paths, no /org/<id> prefix — orgScopedUI stays false.
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
      { title: "Encryption", url: "/settings/encryption", icon: ShieldCheck },
    ],
  },
];

export const settingsSections = getSettingsSections();
