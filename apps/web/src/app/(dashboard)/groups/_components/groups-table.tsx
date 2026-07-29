"use client";

import { useState } from "react";
import { Plus, UsersRound } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Badge } from "@onecli/ui/components/badge";
import { Card } from "@onecli/ui/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@onecli/ui/components/table";
import type { GroupRow } from "@/lib/api";
import { GroupRowActions } from "./group-row-actions";
import { CreateGroupDialog } from "./create-group-dialog";

export interface GroupsTableProps {
  groups: GroupRow[];
}

// No error prop: the parent (groups-content) early-returns AdminOnlyNotice on
// the groups query's error, so this table only renders with a live feed.
export const GroupsTable = ({ groups }: GroupsTableProps) => {
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="size-3.5" />
          Create group
        </Button>
      </div>
      {groups.length === 0 ? (
        <Card className="flex flex-col items-center justify-center py-12 text-center">
          <div className="bg-muted mb-4 flex size-12 items-center justify-center rounded-full">
            <UsersRound className="text-muted-foreground size-6" />
          </div>
          <p className="text-sm font-medium">No groups yet</p>
          <p className="text-muted-foreground mt-1 max-w-xs text-xs">
            Create a group to organize members for project access and policy.
          </p>
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Members</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <span className="font-medium">{row.name}</span>
                    {row.source === "scim" && (
                      <Badge variant="outline" className="ml-2 text-xs">
                        IdP-managed
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{row.memberCount}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(row.createdAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </TableCell>
                  <TableCell>
                    <GroupRowActions group={row} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      <CreateGroupDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
};
