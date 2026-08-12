"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type LucideIcon } from "lucide-react";

import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@onecli/ui/components/sidebar";
import { cn } from "@onecli/ui/lib/utils";
// Type-only the other way (`nav-config` imports `NavItem` from here), so this
// is a one-way runtime dependency — no cycle.
import { isPathUnderNavItem } from "@/lib/nav-config";

const sidebarMenuButtonActiveStyles =
  "font-normal data-[active=true]:bg-brand/10 data-[active=true]:font-medium data-[active=true]:text-brand data-[active=true]:hover:bg-brand/15 dark:data-[active=true]:bg-brand/10 dark:data-[active=true]:text-brand dark:data-[active=true]:hover:bg-brand/15";

export interface NavItem {
  title: string;
  url: string;
  icon: LucideIcon;
}

interface NavMainProps {
  items: NavItem[] | NavItem[][];
  /**
   * Pinned above the nav list and rendered muted — the project shell's
   * "‹ All projects" escape hatch. Optional because the org shell has nowhere
   * to go back TO: it is the outer scope, so it passes no back link. Never
   * rendered as active; it points out of this shell, not at a page inside it.
   */
  backLink?: NavItem;
}

export const NavMain = ({ items, backLink }: NavMainProps) => {
  const pathname = usePathname();

  // The same "is this page under that nav item" rule `resolveNavShell` uses,
  // so the sidebar highlight and the shell split can never disagree. A bare
  // `startsWith` would light `/policy` up for `/policy-drafts`.
  const isActive = (url: string) => {
    if (url === "/") return pathname === "/";
    return isPathUnderNavItem(pathname, url);
  };

  const groups: NavItem[][] =
    items.length > 0 && Array.isArray(items[0])
      ? (items as NavItem[][])
      : [items as NavItem[]];

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-0">
      {backLink && (
        <>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                tooltip={backLink.title}
                className="text-muted-foreground font-normal"
              >
                <Link href={backLink.url}>
                  <backLink.icon />
                  <span>{backLink.title}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <SidebarSeparator className="my-2" />
        </>
      )}
      {groups.map((group, i) => (
        <div key={i}>
          {i > 0 && <SidebarSeparator className="my-2" />}
          <SidebarMenu>
            {group.map((item) => (
              <SidebarMenuItem key={item.url}>
                <SidebarMenuButton
                  asChild
                  isActive={isActive(item.url)}
                  tooltip={item.title}
                  className={cn(sidebarMenuButtonActiveStyles)}
                >
                  <Link href={item.url}>
                    <item.icon />
                    <span>{item.title}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </div>
      ))}
    </SidebarGroup>
  );
};
