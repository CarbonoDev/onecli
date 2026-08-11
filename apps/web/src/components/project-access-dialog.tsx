"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search, TriangleAlert, UsersRound } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import {
  AnimatedTabs,
  AnimatedTabList,
  AnimatedTabTrigger,
  AnimatedTabContent,
} from "@onecli/ui/components/animated-tabs";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Badge } from "@onecli/ui/components/badge";
import { Checkbox } from "@onecli/ui/components/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import { ApiError, type ProjectAccessBindings } from "@/lib/api";
import { useOrgMembersList } from "@/hooks/use-org-members";
import { useGroups } from "@/hooks/use-groups";
import { useSetProjectAccess } from "@/hooks/use-project-access";
import { AdminOnlyNotice } from "./project-access-admin-notice";

export interface ProjectAccessDialogProps {
  projectId: string;
  /** The bindings the buffer is seeded from — never a failed read. */
  current: ProjectAccessBindings;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type ManagementRole = "owner" | "member";

/**
 * Replace-set picker for one project — the group-members dialog extended to two
 * candidate feeds (org members and org groups) sharing one edit buffer. Save
 * PUTs the exact selection back; there are no per-row endpoints.
 */
export const ProjectAccessDialog = ({
  projectId,
  current,
  open,
  onOpenChange,
}: ProjectAccessDialogProps) => {
  const {
    data: memberCandidates = [],
    isPending: membersPending,
    isError: membersError,
    error: membersFailure,
  } = useOrgMembersList(open);
  const {
    data: groupCandidates = [],
    isPending: groupsPending,
    isError: groupsError,
    error: groupsFailure,
  } = useGroups(open);
  const setAccess = useSetProjectAccess();

  const isPending = membersPending || groupsPending;
  // EITHER feed failing must surface as an ERROR, never as an empty baseline:
  // this is a replace-set picker, so seeding from a failed read would render
  // every real grant unchecked and let one toggle + Save wipe the bindings.
  // (`current` is always the live bindings — the card only renders the dialog
  // once they loaded.)
  const isError = membersError || groupsError;
  // A 403 is the EXPECTED admin-only case (a project owner who is not an org
  // admin cannot enumerate the directory); anything else is a transport or
  // server failure and must not be reported as a permission problem.
  const isForbidden = [membersFailure, groupsFailure].some(
    (failure) => failure instanceof ApiError && failure.status === 403,
  );

  const [tab, setTab] = useState("people");
  const [users, setUsers] = useState<Map<string, ManagementRole>>(
    () => new Map(),
  );
  const [groupIds, setGroupIds] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");

  const initialUsers = useMemo(
    () => new Map(current.users.map((u) => [u.userId, u.role])),
    [current.users],
  );
  const initialGroups = useMemo(
    () => new Set(current.groups.map((g) => g.groupId)),
    [current.groups],
  );

  // Seed the edit buffer once per open, once both feeds settle — guarded so a
  // background refetch can't clobber in-progress edits. Search clears on close.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!open) {
      seededRef.current = false;
      setSearch("");
      setTab("people");
      return;
    }
    if (seededRef.current || isPending || isError) return;
    setUsers(new Map(initialUsers));
    setGroupIds(new Set(initialGroups));
    seededRef.current = true;
  }, [open, isPending, isError, initialUsers, initialGroups]);

  const filteredMembers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return memberCandidates;
    return memberCandidates.filter(
      (m) =>
        m.email.toLowerCase().includes(q) ||
        (m.name ?? "").toLowerCase().includes(q),
    );
  }, [memberCandidates, search]);

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return groupCandidates;
    return groupCandidates.filter((g) => g.name.toLowerCase().includes(q));
  }, [groupCandidates, search]);

  const dirty = useMemo(() => {
    if (users.size !== initialUsers.size) return true;
    for (const [id, role] of users) {
      if (initialUsers.get(id) !== role) return true;
    }
    if (groupIds.size !== initialGroups.size) return true;
    for (const id of groupIds) if (!initialGroups.has(id)) return true;
    return false;
  }, [users, groupIds, initialUsers, initialGroups]);

  const hasOwner = [...users.values()].includes("owner");

  const toggleUser = (userId: string) => {
    setUsers((prev) => {
      const next = new Map(prev);
      if (next.has(userId)) next.delete(userId);
      // Checking a person defaults them to a plain use grant; the per-row
      // select promotes.
      else next.set(userId, "member");
      return next;
    });
  };

  const setUserRole = (userId: string, role: ManagementRole) => {
    setUsers((prev) => {
      const next = new Map(prev);
      if (next.has(userId)) next.set(userId, role);
      return next;
    });
  };

  const toggleGroup = (groupId: string) => {
    setGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  // Select-all/clear act on ALL candidates, not just the filtered view.
  const selectAll = () => {
    if (tab === "people") {
      setUsers((prev) => {
        const next = new Map(prev);
        for (const m of memberCandidates) {
          if (!next.has(m.userId)) next.set(m.userId, "member");
        }
        return next;
      });
    } else {
      setGroupIds(new Set(groupCandidates.map((g) => g.id)));
    }
  };
  const clearAll = () => {
    if (tab === "people") setUsers(new Map());
    else setGroupIds(new Set());
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await setAccess.mutateAsync({
        projectId,
        users: [...users].map(([userId, role]) => ({ userId, role })),
        groupIds: [...groupIds],
      });
      onOpenChange(false);
      toast.success("Project access updated");
    } catch {
      // The mutation hook already toasts the server reason — keep the dialog
      // open so the selection isn't lost.
    } finally {
      setSaving(false);
    }
  };

  const selectedCount = tab === "people" ? users.size : groupIds.size;
  const candidateCount =
    tab === "people" ? memberCandidates.length : groupCandidates.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="p-6 pb-4">
          <DialogTitle>Manage project access</DialogTitle>
          <p className="text-muted-foreground text-xs leading-relaxed">
            Choose who can use this project. Owners can also rename, share and
            delete it. Groups grant access to everyone in them.
          </p>
        </DialogHeader>

        <div className="px-6 pb-1">
          {isError ? (
            isForbidden ? (
              <AdminOnlyNotice />
            ) : (
              <div className="my-6 rounded-md border p-4 text-center">
                <p className="text-sm font-medium">
                  Couldn&apos;t load candidates
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  Something went wrong fetching the organization&apos;s members
                  and groups. Close this dialog and try again.
                </p>
              </div>
            )
          ) : isPending ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="text-muted-foreground size-4 animate-spin" />
            </div>
          ) : (
            <AnimatedTabs value={tab} onValueChange={setTab}>
              <AnimatedTabList>
                <AnimatedTabTrigger value="people">People</AnimatedTabTrigger>
                <AnimatedTabTrigger value="groups">Groups</AnimatedTabTrigger>
              </AnimatedTabList>

              <div className="space-y-2 pt-4">
                <div className="relative">
                  <Search
                    className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
                    aria-hidden="true"
                  />
                  <Input
                    placeholder={
                      tab === "people" ? "Filter people..." : "Filter groups..."
                    }
                    aria-label="Filter candidates"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="h-8 pl-8 text-sm"
                  />
                </div>

                <div className="flex items-center justify-between">
                  <p
                    className="text-muted-foreground text-xs"
                    aria-live="polite"
                  >
                    <span className="text-foreground font-medium">
                      {selectedCount}
                    </span>{" "}
                    of {candidateCount} selected
                  </p>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={selectAll}
                      className="text-muted-foreground hover:text-foreground text-xs transition-colors"
                    >
                      Select all
                    </button>
                    <span className="text-muted-foreground/40 text-xs">/</span>
                    <button
                      type="button"
                      onClick={clearAll}
                      className="text-muted-foreground hover:text-foreground text-xs transition-colors"
                    >
                      Clear
                    </button>
                  </div>
                </div>
              </div>

              {/* A native max-height scroller, as in the group-members dialog:
                  it shrinks to fit a few rows and caps at the viewport. */}
              <AnimatedTabContent value="people" className="pt-2">
                <div className="max-h-[min(24rem,50vh)] overflow-y-auto rounded-md border">
                  <div className="divide-border divide-y">
                    {filteredMembers.map((row) => (
                      <div
                        key={row.userId}
                        className="hover:bg-muted/50 flex items-center gap-3 px-3 py-2.5 transition-colors"
                      >
                        <Checkbox
                          id={`access-user-${row.userId}`}
                          checked={users.has(row.userId)}
                          onCheckedChange={() => toggleUser(row.userId)}
                        />
                        <label
                          htmlFor={`access-user-${row.userId}`}
                          className="min-w-0 flex-1 cursor-pointer"
                        >
                          <p className="truncate text-sm font-medium">
                            {row.name ?? row.email}
                          </p>
                          {row.name && (
                            <p className="text-muted-foreground truncate text-xs">
                              {row.email}
                            </p>
                          )}
                        </label>
                        {row.status === "suspended" && (
                          <Badge variant="outline" className="shrink-0 text-xs">
                            Suspended
                          </Badge>
                        )}
                        <Select
                          value={users.get(row.userId) ?? "member"}
                          disabled={!users.has(row.userId)}
                          onValueChange={(value) =>
                            setUserRole(
                              row.userId,
                              value === "owner" ? "owner" : "member",
                            )
                          }
                        >
                          <SelectTrigger
                            size="sm"
                            className="w-28 shrink-0"
                            aria-label={`Role for ${row.email}`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="owner">Owner</SelectItem>
                            <SelectItem value="member">Member</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    ))}

                    {filteredMembers.length === 0 && (
                      <p className="text-muted-foreground py-6 text-center text-xs">
                        {memberCandidates.length === 0
                          ? "Invite teammates from the Team page to share this project."
                          : `No people match “${search}”`}
                      </p>
                    )}
                  </div>
                </div>
              </AnimatedTabContent>

              <AnimatedTabContent value="groups" className="pt-2">
                <div className="max-h-[min(24rem,50vh)] overflow-y-auto rounded-md border">
                  <div className="divide-border divide-y">
                    {filteredGroups.map((row) => (
                      <label
                        key={row.id}
                        className="hover:bg-muted/50 flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors"
                      >
                        <Checkbox
                          checked={groupIds.has(row.id)}
                          onCheckedChange={() => toggleGroup(row.id)}
                        />
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
                        {row.source === "scim" && (
                          <Badge variant="outline" className="shrink-0 text-xs">
                            IdP-managed
                          </Badge>
                        )}
                      </label>
                    ))}

                    {filteredGroups.length === 0 && (
                      <p className="text-muted-foreground py-6 text-center text-xs">
                        {groupCandidates.length === 0
                          ? "Create a group on the Groups page to share this project with a team."
                          : `No groups match “${search}”`}
                      </p>
                    )}
                  </div>
                </div>
              </AnimatedTabContent>
            </AnimatedTabs>
          )}
        </div>

        <DialogFooter className="border-border/50 flex-col items-stretch gap-2 border-t px-6 py-4 sm:flex-row sm:items-center sm:justify-end">
          {!isError && !isPending && !hasOwner && (
            <p className="text-muted-foreground mr-auto flex items-center gap-1.5 text-xs">
              <TriangleAlert className="size-3.5 shrink-0" />A project must keep
              at least one owner.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              loading={saving}
              disabled={isPending || isError || !dirty || !hasOwner}
            >
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
