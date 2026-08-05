import {
  LayoutDashboard,
  Bot,
  Settings,
  Plug,
  Webhook,
  Activity,
  User,
  Users,
  UsersRound,
  KeyRound,
  ShieldCheck,
  Globe,
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
  { title: "Agents", url: "/agents", icon: Bot },
  { title: "Connections", url: "/connections", icon: Plug },
  // The inbound counterpart to Connections: providers POST here and a remote
  // consumer drains the queue. Top-level rather than a Connections tab because
  // it owns a detail route, which that (tabs) shell would wrap in the wrong
  // header — the same reason /connections/apps/[provider] sits outside it.
  { title: "Webhooks", url: "/webhooks", icon: Webhook },
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
  { title: "Settings", url: "/settings", icon: Settings },
];

export const getSettingsSections = (
  // The EE org-UI override uses orgId to prefix URLs with /org/<id>
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  orgId?: string,
): SettingsNavSection[] => [
  {
    label: "General",
    items: [{ title: "Instance", url: "/settings/instance", icon: Globe }],
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
