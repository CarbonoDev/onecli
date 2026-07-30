"use client";

import { useState } from "react";
import { Loader2, Trash2, UserPlus, UsersRound } from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Button } from "@onecli/ui/components/button";
import { Badge } from "@onecli/ui/components/badge";
import { Skeleton } from "@onecli/ui/components/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@onecli/ui/components/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import type { ProjectAccessBindings, SetProjectAccessInput } from "@/lib/api";
import {
  useProjectAccess,
  useSetProjectAccess,
} from "@/hooks/use-project-access";
import { LocalModeNotice } from "./local-mode-notice";
import { ProjectAccessDialog } from "./project-access-dialog";

export interface ProjectAccessCardProps {
  projectId: string;
  userId: string;
  canManage: boolean;
  isOrgAdmin: boolean;
  sharingEnabled: boolean;
}

/**
 * The contract has NO per-row endpoints: every row action PUTs the FULL set.
 * So each control builds the next set from the currently-cached bindings and
 * applies exactly one change — one write path, with the server's guards (an
 * owner must remain; nobody may strand themselves) as the safety net.
 */
const toInput = (bindings: ProjectAccessBindings): SetProjectAccessInput => ({
  users: bindings.users.map((u) => ({ userId: u.userId, role: u.role })),
  groupIds: bindings.groups.map((g) => g.groupId),
});

/** The row a confirmation dialog is currently asking about. */
type PendingRemoval =
  | { kind: "user"; userId: string; label: string; isSelf: boolean }
  | { kind: "group"; groupId: string; name: string; memberCount: number };

export const ProjectAccessCard = ({
  projectId,
  userId,
  canManage,
  isOrgAdmin,
  sharingEnabled,
}: ProjectAccessCardProps) => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [removal, setRemoval] = useState<PendingRemoval | null>(null);
  // Which ROW is mutating, so the click that started it shows a spinner
  // instead of silently greying every control out.
  const [busyRowId, setBusyRowId] = useState<string | null>(null);
  const access = useProjectAccess(projectId, sharingEnabled);
  const setAccess = useSetProjectAccess();

  const bindings = access.data;
  const ownerCount =
    bindings?.users.filter((u) => u.role === "owner").length ?? 0;

  const apply = (rowId: string, next: SetProjectAccessInput) => {
    setBusyRowId(rowId);
    setAccess.mutate(
      { projectId, ...next },
      // The hook toasts the server's reason on failure — including the guard
      // messages, which are the whole point of this surface.
      {
        onSuccess: () => {
          setRemoval(null);
          toast.success("Project access updated");
        },
        onSettled: () => setBusyRowId(null),
      },
    );
  };

  const removeUser = (targetUserId: string) => {
    if (!bindings) return;
    const next = toInput(bindings);
    apply(targetUserId, {
      ...next,
      users: next.users.filter((u) => u.userId !== targetUserId),
    });
  };

  const changeUserRole = (targetUserId: string, role: "owner" | "member") => {
    if (!bindings) return;
    const next = toInput(bindings);
    apply(targetUserId, {
      ...next,
      users: next.users.map((u) =>
        u.userId === targetUserId ? { ...u, role } : u,
      ),
    });
  };

  const removeGroup = (groupId: string) => {
    if (!bindings) return;
    const next = toInput(bindings);
    apply(groupId, {
      ...next,
      groupIds: next.groupIds.filter((id) => id !== groupId),
    });
  };

  const confirmRemoval = () => {
    if (!removal) return;
    if (removal.kind === "user") removeUser(removal.userId);
    else removeGroup(removal.groupId);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Access</CardTitle>
        <CardDescription>
          People and groups who can use this project. Owners can also rename,
          share and delete it.
        </CardDescription>
        {sharingEnabled && (
          <CardAction>
            <Button
              size="sm"
              disabled={!canManage || access.isPending || access.isError}
              onClick={() => setDialogOpen(true)}
            >
              <UserPlus className="size-3.5" />
              Manage access
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-6">
        {!sharingEnabled ? (
          <LocalModeNotice />
        ) : access.isPending ? (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : access.isError ? (
          <div className="rounded-md border p-4">
            <p className="text-sm font-medium">Couldn&apos;t load access</p>
            <p className="text-muted-foreground mt-1 text-xs">
              Something went wrong fetching this project&apos;s bindings. Reload
              the page to try again.
            </p>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <h3 className="text-sm font-medium">People</h3>
              {bindings && bindings.users.length > 0 ? (
                <div className="divide-border divide-y rounded-md border">
                  {bindings.users.map((row) => {
                    // Client-side mirror of the server's "keep one owner"
                    // guard, so the common case never round-trips to a 400.
                    const isLastOwner = row.role === "owner" && ownerCount <= 1;
                    // A non-admin may not drop or demote themselves (the
                    // server refuses). An admin CAN, for hand-off — the server
                    // only stops them when it would leave them with no project
                    // at all, which the client cannot know (it sees one
                    // project), so that case stays a server 400 and the
                    // confirmation below spells the risk out.
                    const isSelfLock = row.userId === userId && !isOrgAdmin;
                    const locked = isLastOwner || isSelfLock;
                    const lockReason = isLastOwner
                      ? "A project must keep at least one owner"
                      : "You cannot remove your own access to this project";
                    const busy =
                      setAccess.isPending && busyRowId === row.userId;

                    return (
                      <div
                        key={row.id}
                        className="flex items-center gap-3 px-3 py-2.5"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {row.name ?? row.email}
                          </p>
                          {row.name && (
                            <p className="text-muted-foreground truncate text-xs">
                              {row.email}
                            </p>
                          )}
                        </div>
                        {row.isOwner && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge variant="outline" className="shrink-0">
                                Creator
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent>
                              Created this project. Removing their access also
                              stops their project API key from working.
                            </TooltipContent>
                          </Tooltip>
                        )}
                        <Select
                          value={row.role}
                          disabled={!canManage || locked || setAccess.isPending}
                          onValueChange={(value) =>
                            changeUserRole(
                              row.userId,
                              value === "owner" ? "owner" : "member",
                            )
                          }
                        >
                          <SelectTrigger
                            size="sm"
                            className="w-28"
                            aria-label={`Role for ${row.email}`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="owner">Owner</SelectItem>
                            <SelectItem value="member">Member</SelectItem>
                          </SelectContent>
                        </Select>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-8"
                                aria-label={`Remove ${row.email}`}
                                disabled={
                                  !canManage || locked || setAccess.isPending
                                }
                                onClick={() =>
                                  setRemoval({
                                    kind: "user",
                                    userId: row.userId,
                                    label: row.name ?? row.email,
                                    isSelf: row.userId === userId,
                                  })
                                }
                              >
                                {busy ? (
                                  <Loader2 className="size-4 animate-spin" />
                                ) : (
                                  <Trash2 className="size-4" />
                                )}
                              </Button>
                            </span>
                          </TooltipTrigger>
                          {locked && (
                            <TooltipContent>{lockReason}</TooltipContent>
                          )}
                        </Tooltip>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-muted-foreground text-xs">
                  Nobody has direct access to this project yet.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <h3 className="text-sm font-medium">Groups</h3>
              {bindings && bindings.groups.length > 0 ? (
                <div className="divide-border divide-y rounded-md border">
                  {bindings.groups.map((row) => {
                    const busy =
                      setAccess.isPending && busyRowId === row.groupId;
                    return (
                      <div
                        key={row.id}
                        className="flex items-center gap-3 px-3 py-2.5"
                      >
                        <UsersRound className="text-muted-foreground size-4 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {row.name}
                          </p>
                          <p className="text-muted-foreground truncate text-xs">
                            {row.memberCount} member
                            {row.memberCount === 1 ? "" : "s"}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          aria-label={`Remove ${row.name}`}
                          disabled={!canManage || setAccess.isPending}
                          onClick={() =>
                            setRemoval({
                              kind: "group",
                              groupId: row.groupId,
                              name: row.name,
                              memberCount: row.memberCount,
                            })
                          }
                        >
                          {busy ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Trash2 className="size-4" />
                          )}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-muted-foreground text-xs">
                  No groups have access to this project.
                </p>
              )}
              <p className="text-muted-foreground text-xs">
                Everyone in a group listed here can use the project. Deleting
                the group removes that access.
              </p>
            </div>
          </>
        )}
      </CardContent>

      {sharingEnabled && bindings && (
        <ProjectAccessDialog
          projectId={projectId}
          current={bindings}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
        />
      )}

      {/* Removing a binding revokes LIVE authorization — the gateway and the
          API both read these rows — so it is confirmed like every other
          destructive action in the app, with the concrete consequence named. */}
      <AlertDialog
        open={removal !== null}
        onOpenChange={(open) => {
          if (!open && !setAccess.isPending) setRemoval(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {removal?.kind === "group"
                ? `Remove ${removal.name}?`
                : `Remove ${removal?.label ?? "this person"}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {removal?.kind === "group"
                ? `All ${removal.memberCount} member${
                    removal.memberCount === 1 ? "" : "s"
                  } of this group lose access to this project immediately, unless they also have direct access.`
                : "They lose access to this project immediately, and any project API key they hold stops authenticating."}
              {removal?.kind === "user" && removal.isSelf
                ? " This is your own access: if this project is the only one you can reach, the API will refuse rather than lock you out."
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={setAccess.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(e) => {
                e.preventDefault();
                confirmRemoval();
              }}
              disabled={setAccess.isPending}
            >
              {setAccess.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Removing...
                </>
              ) : (
                "Remove"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
};
