"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, Check, ChevronsUpDown, Loader2, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
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
import { useSwitchOrganization } from "@/hooks/use-switch-organization";
import { session, type CreatedOrganization } from "@/lib/api";
import { CAPS } from "@/lib/env";
import { usePlanGate } from "@/lib/plan-gate";
import { CreateOrganizationDialog } from "./create-organization-dialog";

/**
 * Whether this edition lets a user create organizations. `single-org-shared`
 * (onprem) has exactly one by construction and puts every member in it, so a
 * second would be unreachable rather than useful — the same refusal the
 * service enforces server-side.
 */
const CAN_CREATE_ORG = CAPS.tenancy !== "single-org-shared";

/**
 * Switch between the organizations a user belongs to, and create new ones.
 *
 * Multi-org membership is ordinary rather than exotic: every user gets their
 * own org at bootstrap, and accepting an invitation adds a membership in
 * someone else's — so anyone who has accepted an invite belongs to at least
 * two, and until now had no way to reach the second.
 *
 * Rendered whenever there is somewhere to GO: two or more memberships, or one
 * plus the ability to create another. A single-org user on an edition that
 * forbids creating more still gets nothing — a switcher that can neither
 * switch nor create is noise.
 */
export const OrgSwitcher = () => {
  const router = useRouter();
  const { data: orgs = [], isLoading } = useOrganizationsList();
  const currentId = useCurrentOrganizationId();
  const switchOrganization = useSwitchOrganization();
  const planGate = usePlanGate();
  const [switching, setSwitching] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const switchTo = async (organizationId: string) => {
    if (organizationId === currentId || switching) return;
    setSwitching(true);
    // Ask the server where this switch LANDS before touching any cookie. The
    // org's default project is `findUserDefaultProject`'s answer and nothing
    // else; deriving it here ("first row of the projects list") would be a
    // second definition, free to drift from the one every request resolves
    // against. A failed lookup is not fatal — switch with no project and let
    // the org-scoped default answer on the next request.
    const landing = await session.get({ organizationId }).catch(() => null);
    switchOrganization({ organizationId, projectId: landing?.projectId });
    router.refresh();
    setSwitching(false);
  };

  // A brand-new org holds nothing the current page can show, and the page may
  // not even exist there (an agent detail route scoped to the old org). Land
  // on the overview rather than refreshing in place.
  const handleCreated = (organization: CreatedOrganization) => {
    switchOrganization({
      organizationId: organization.id,
      projectId: organization.projectId,
    });
    router.push("/overview");
  };

  const openCreate = () => {
    // No-op in OSS; the cloud gate opens its paywall and swallows the click.
    if (planGate.guard("organization.create")) return;
    setCreateOpen(true);
  };

  if (isLoading || (orgs.length < 2 && !CAN_CREATE_ORG)) return null;

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
              {switching ? (
                <Loader2 className="size-4 shrink-0 animate-spin" />
              ) : (
                <Building2 className="size-4 shrink-0" />
              )}
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
                onSelect={() => void switchTo(org.id)}
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
            {CAN_CREATE_ORG && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={openCreate} className="gap-2">
                  <Plus className="size-4 shrink-0" />
                  New organization
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>

      <CreateOrganizationDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
      />
    </SidebarMenu>
  );
};
