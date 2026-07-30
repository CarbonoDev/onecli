"use client";

import { useState } from "react";
import { Lock, Plus, Shuffle } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@onecli/ui/components/table";
import { useGroups } from "@/hooks/use-groups";
import {
  useReorderRoleMappings,
  useRoleMappings,
} from "@/hooks/use-role-mappings";
import { RoleMappingDialog } from "./role-mapping-dialog";
import { RoleMappingRowActions } from "./role-mapping-row-actions";

export interface RoleMappingsSectionProps {
  /** Threaded from the RSC page — false = local auth mode (no org backend). */
  groupsEnabled: boolean;
}

/**
 * Group→role mappings: members of a mapped group are granted at least its role.
 *
 * Ordering is load-bearing. Mappings are first-match by priority (top of the
 * list wins), and the effect is MONOTONIC — a mapping can only RAISE a member's
 * role, never lower it. So a member in several mapped groups lands on the
 * highest role any applicable mapping grants, and reordering only matters where
 * mappings would otherwise disagree.
 *
 * The section sits below the groups table on `/groups`. It renders for admins
 * only: the parent already replaces the whole surface with the admin-only
 * notice when the groups directory 403s, so a non-admin never reaches this.
 * The defensive error branch stays for the rare case the two reads disagree.
 */
export const RoleMappingsSection = ({
  groupsEnabled,
}: RoleMappingsSectionProps) => {
  const mappings = useRoleMappings(groupsEnabled);
  // The create dialog offers groups that DON'T already have a mapping (a group
  // maps to at most one role — a second create 409s server-side).
  const groups = useGroups(groupsEnabled);
  const reorder = useReorderRoleMappings();
  const [createOpen, setCreateOpen] = useState(false);

  // Inert without an org backend — the parent returns before this in local mode,
  // but guard anyway so an accidental mount fires no doomed request.
  if (!groupsEnabled) return null;

  const rows = mappings.data ?? [];
  const mappedGroupIds = new Set(rows.map((m) => m.groupId));
  const availableGroups = (groups.data ?? []).filter(
    (g) => !mappedGroupIds.has(g.id),
  );

  const move = (index: number, direction: "up" | "down") => {
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= rows.length) return;
    const orderedIds = rows.map((m) => m.id);
    const moved = orderedIds.splice(index, 1);
    orderedIds.splice(target, 0, ...moved);
    reorder.mutate(orderedIds);
  };

  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Role mappings</h2>
          <p className="text-muted-foreground max-w-2xl text-sm">
            Grant members of a group an organization role automatically.
            Mappings only <span className="font-medium">raise</span> a
            member&apos;s role, never lower it. When several apply, the
            highest-priority mapping wins — top of the list first.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => setCreateOpen(true)}
          disabled={mappings.isError}
        >
          <Plus className="size-3.5" />
          Add mapping
        </Button>
      </div>

      {mappings.isPending ? (
        <Card className="p-6">
          <div className="space-y-3">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-5 w-64" />
          </div>
        </Card>
      ) : mappings.isError ? (
        <Card className="flex flex-col items-center justify-center py-12 text-center">
          <div className="bg-muted mb-4 flex size-12 items-center justify-center rounded-full">
            <Lock className="text-muted-foreground size-6" />
          </div>
          <p className="text-sm font-medium">Admins only</p>
          <p className="text-muted-foreground mt-1 max-w-xs text-xs">
            Managing role mappings requires an organization admin.
          </p>
        </Card>
      ) : rows.length === 0 ? (
        <Card className="flex flex-col items-center justify-center py-12 text-center">
          <div className="bg-muted mb-4 flex size-12 items-center justify-center rounded-full">
            <Shuffle className="text-muted-foreground size-6" />
          </div>
          <p className="text-sm font-medium">No role mappings yet</p>
          <p className="text-muted-foreground mt-1 max-w-xs text-xs">
            Map a group to a role so its members are granted it automatically.
          </p>
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">Priority</TableHead>
                <TableHead>Group</TableHead>
                <TableHead>Grants role</TableHead>
                <TableHead>Members</TableHead>
                <TableHead className="w-32 text-right">Order</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((mapping, index) => (
                <TableRow key={mapping.id}>
                  <TableCell className="text-muted-foreground tabular-nums">
                    {index + 1}
                  </TableCell>
                  <TableCell className="font-medium">
                    {mapping.groupName}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        mapping.role === "admin" ? "default" : "secondary"
                      }
                    >
                      {mapping.role}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{mapping.memberCount}</Badge>
                  </TableCell>
                  <TableCell>
                    <RoleMappingRowActions
                      mapping={mapping}
                      groups={groups.data ?? []}
                      canMoveUp={index > 0}
                      canMoveDown={index < rows.length - 1}
                      onMove={(direction) => move(index, direction)}
                      reordering={reorder.isPending}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <RoleMappingDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        availableGroups={availableGroups}
      />
    </section>
  );
};
