"use client";

import * as React from "react";
import Image from "next/image";
import Link from "next/link";
import { NavMain } from "./nav-main";
import { NavUser } from "./nav-user";
import { ProjectSwitcher } from "./project-switcher";
import { OrgSwitcher } from "./org-switcher";
import { useNavShell } from "@/hooks/use-nav-shell";
import {
  orgNavItems,
  projectBackLink,
  projectNavItems,
} from "@/lib/nav-config";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from "@onecli/ui/components/sidebar";

export const DashboardSidebar = ({
  ...props
}: React.ComponentProps<typeof Sidebar>) => {
  // Derived, not held in context: the header calls the same hook, so the two
  // can never disagree about which shell they are in.
  const shell = useNavShell();

  return (
    <Sidebar collapsible="icon" variant="inset" {...props}>
      <SidebarHeader className="h-12 justify-center group-data-[collapsible=icon]:px-0">
        <Link
          href="https://onecli.sh"
          target="_blank"
          className="flex items-center px-2"
        >
          <Image
            src="/onecli-full-logo.png"
            alt="OneCLI"
            width={80}
            height={23}
            priority
            className="group-data-[collapsible=icon]:hidden dark:hidden"
          />
          <Image
            src="/onecli-full-logo-dark.png"
            alt="OneCLI"
            width={80}
            height={23}
            priority
            className="hidden dark:group-data-[collapsible=icon]:!hidden dark:block"
          />
          {/* SVG (unlike the two PNG wordmarks above): the Next image
              optimizer 400s on SVG, so serve it straight from `public/`
              (see AppIcon). */}
          <Image
            src="/logo-icon.svg"
            alt="OneCLI"
            width={20}
            height={20}
            unoptimized
            className="hidden group-data-[collapsible=icon]:block"
          />
        </Link>
      </SidebarHeader>
      <SidebarContent>
        {/* Both switchers stay in BOTH shells. This is a deliberate product
            decision, not an oversight: the two-shell split is about what the
            nav LISTS, while switching org or project is one click here versus
            three through the projects grid. Keeping the project switcher in
            the org shell is what makes "jump straight into another project"
            possible from anywhere. */}
        <div className="px-2 group-data-[collapsible=icon]:px-0">
          <OrgSwitcher />
          <ProjectSwitcher />
        </div>
        {shell === "project" ? (
          <NavMain items={projectNavItems} backLink={projectBackLink} />
        ) : (
          <NavMain items={orgNavItems} />
        )}
      </SidebarContent>
      <SidebarFooter className="justify-center group-data-[collapsible=icon]:px-0">
        <NavUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
};
