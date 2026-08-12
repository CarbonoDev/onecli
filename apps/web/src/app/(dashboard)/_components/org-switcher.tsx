"use client";

import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, Check, ChevronsUpDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@onecli/ui/components/sidebar";
import { cn } from "@onecli/ui/lib/utils";
import {
  useCurrentOrganizationId,
  useOrganizationsList,
} from "@/hooks/use-organizations";
import {
  clearDefaultProjectCookie,
  writeDefaultOrgCookie,
} from "@/lib/navigation";
import { queryKeys } from "@/lib/api/keys";

/**
 * Switch between the organizations a user belongs to.
 *
 * Multi-org membership is ordinary rather than exotic: every user gets their
 * own org at bootstrap, and accepting an invitation adds a membership in
 * someone else's — so anyone who has accepted an invite belongs to at least
 * two, and until now had no way to reach the second.
 *
 * Renders only when there is a genuine choice. Gated on the membership COUNT,
 * not an edition flag: `single-org-shared` deployments have one org by
 * construction, and a one-item switcher is noise on any edition.
 */
export const OrgSwitcher = () => {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: orgs = [], isLoading } = useOrganizationsList();
  const currentId = useCurrentOrganizationId();

  const switchTo = (organizationId: string) => {
    if (organizationId === currentId) return;
    writeDefaultOrgCookie(organizationId);
    // Non-negotiable: a project cookie from the PREVIOUS org would otherwise
    // win, because the project header takes precedence over the org header and
    // the org is derived from the resolved project. Clearing it lets the new
    // org's default project resolve.
    clearDefaultProjectCookie();
    // Everything cached belongs to the old org. `getOrganizationId()` now
    // returns the cookie so keys do change, but clearing drops the old org's
    // entries rather than leaving them resident.
    queryClient.clear();
    // Re-seed AFTER the clear (which dropped it too), synchronously: every
    // `useCurrentOrganizationId` subscriber — this switcher's own label, and
    // any page already mounted — moves to the new org in the same render. The
    // cookie query would otherwise not re-read until a remount, and
    // `router.refresh()` does not remount client components.
    queryClient.setQueryData(
      queryKeys.scope.organizationCookie(),
      organizationId,
    );
    router.refresh();
  };

  if (isLoading || orgs.length < 2) return null;

  const current = orgs.find((o) => o.id === currentId);
  const label = current?.name ?? "Select organization";

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              className="data-[state=open]:bg-sidebar-accent"
              tooltip={label}
            >
              <Building2 className="size-4 shrink-0" />
              <span className="truncate">{label}</span>
              <ChevronsUpDown className="ml-auto size-4 shrink-0 opacity-50" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            side="bottom"
            className="w-56"
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-muted-foreground text-xs">
              Organizations
            </DropdownMenuLabel>
            {orgs.map((org) => (
              <DropdownMenuItem
                key={org.id}
                onSelect={() => switchTo(org.id)}
                className="gap-2"
              >
                <Check
                  className={cn(
                    "size-4 shrink-0",
                    org.id === currentId ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="truncate">{org.name}</span>
                <span className="text-muted-foreground ml-auto text-xs">
                  {org.role}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
};
