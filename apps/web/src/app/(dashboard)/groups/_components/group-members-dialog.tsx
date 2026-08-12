"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { UsersRound, Loader2, Search, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Badge } from "@onecli/ui/components/badge";
import { Checkbox } from "@onecli/ui/components/checkbox";
import { MAX_GROUP_MEMBERS } from "@onecli/api/validations/org";
import { useOrgMembersList } from "@/hooks/use-org-members";
import { useGroupMembers, useSetGroupMembers } from "@/hooks/use-groups";

export interface GroupMembersDialogProps {
  groupId: string;
  groupName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Replace-set member picker for one group: candidates are the org's members
 * (`useOrgMembersList`), the current set is the group's members, and Save PUTs
 * the exact selection back. Scales via a filter + select-all/clear, with a
 * viewport-bounded scroll list so the dialog never overflows.
 */
export const GroupMembersDialog = ({
  groupId,
  groupName,
  open,
  onOpenChange,
}: GroupMembersDialogProps) => {
  const {
    data: candidates = [],
    isPending: candidatesPending,
    isError: candidatesError,
  } = useOrgMembersList(open);
  const {
    data: current = [],
    isPending: currentPending,
    isError: currentError,
  } = useGroupMembers(groupId, open);
  const setMembers = useSetGroupMembers();
  const isPending = candidatesPending || currentPending;
  // Either feed failing must surface as an ERROR, never an empty baseline:
  // this is a replace-set picker, so seeding from a failed current-members
  // read would render every real member unchecked and let one toggle + Save
  // silently wipe the group's membership.
  const isError = candidatesError || currentError;

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");

  const initialSelected = useMemo(
    () => new Set(current.map((m) => m.userId)),
    [current],
  );

  // Seed the edit buffer once per open, once both feeds load — guarded so a
  // background refetch can't clobber in-progress edits. Search clears on close.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!open) {
      seededRef.current = false;
      setSearch("");
      return;
    }
    if (seededRef.current || isPending || isError) return;
    setSelected(new Set(initialSelected));
    seededRef.current = true;
  }, [open, isPending, isError, initialSelected]);

  const filteredCandidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(
      (m) =>
        m.email.toLowerCase().includes(q) ||
        (m.name ?? "").toLowerCase().includes(q),
    );
  }, [candidates, search]);

  const dirty = useMemo(() => {
    if (selected.size !== initialSelected.size) return true;
    for (const id of selected) if (!initialSelected.has(id)) return true;
    return false;
  }, [selected, initialSelected]);

  const toggle = (userId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  // Select-all/clear act on ALL candidates, not just the filtered view. A
  // group caps at MAX_GROUP_MEMBERS server-side, so past that many candidates
  // Select-all can't produce a saveable set — disable it and say why rather
  // than let Save PUT an oversized set that fails validation with a raw 422.
  const selectAllExceedsCap = candidates.length > MAX_GROUP_MEMBERS;
  const selectAll = () => setSelected(new Set(candidates.map((m) => m.userId)));
  const clearAll = () => setSelected(new Set());

  const handleSave = async () => {
    setSaving(true);
    try {
      await setMembers.mutateAsync({ groupId, userIds: [...selected] });
      onOpenChange(false);
      toast.success("Group members updated");
    } catch {
      // The mutation hook already toasts the server reason — just keep the
      // dialog open so the selection isn't lost.
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="p-6 pb-4">
          <DialogTitle>Members of {groupName}</DialogTitle>
          {/* The copy was already here as a bare `<p>`; only
              `DialogDescription` is wired to the dialog's `aria-describedby`. */}
          <DialogDescription className="text-xs leading-relaxed">
            Choose which organization members belong to this group. Project
            access granted to the group follows its membership.
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 pb-1">
          {isError ? (
            <div className="flex items-start gap-2 rounded-md border p-4">
              <TriangleAlert className="text-destructive mt-0.5 size-4 shrink-0" />
              <div>
                <p className="text-sm font-medium">
                  Couldn&apos;t load members
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  Something went wrong fetching the member lists. Close the
                  dialog and try again.
                </p>
              </div>
            </div>
          ) : isPending ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="text-muted-foreground size-4 animate-spin" />
            </div>
          ) : candidates.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <div className="bg-muted mb-3 flex size-10 items-center justify-center rounded-full">
                <UsersRound className="text-muted-foreground size-4" />
              </div>
              <p className="text-sm font-medium">No members yet</p>
              <p className="text-muted-foreground mt-1 text-xs">
                Invite teammates from the Team page to add them to groups.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {/* Search */}
              <div className="relative">
                <Search
                  className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
                  aria-hidden="true"
                />
                <Input
                  placeholder="Filter members..."
                  aria-label="Filter members by name or email"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-8 pl-8 text-sm"
                />
              </div>

              {/* Toolbar: count + bulk actions */}
              <div className="flex items-center justify-between">
                <p className="text-muted-foreground text-xs" aria-live="polite">
                  <span className="text-foreground font-medium">
                    {selected.size}
                  </span>{" "}
                  of {candidates.length} selected
                </p>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={selectAll}
                    disabled={selectAllExceedsCap}
                    title={
                      selectAllExceedsCap
                        ? `A group can hold at most ${MAX_GROUP_MEMBERS.toLocaleString()} members`
                        : undefined
                    }
                    className="text-muted-foreground hover:text-foreground text-xs transition-colors disabled:pointer-events-none disabled:opacity-40"
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

              {/* List — a native max-height scroller: it shrinks to fit a few
                  members and caps at the viewport, scrolling the rows for many.
                  (A Radix ScrollArea can't scroll under `max-height` — its
                  viewport needs a *definite* height — so it would clip instead
                  of scroll; a plain overflow container is correct here.) */}
              <div className="max-h-[min(24rem,50vh)] overflow-y-auto rounded-md border">
                <div className="divide-border divide-y">
                  {filteredCandidates.map((memberRow) => (
                    <label
                      key={memberRow.userId}
                      className="hover:bg-muted/50 flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors"
                    >
                      <Checkbox
                        checked={selected.has(memberRow.userId)}
                        onCheckedChange={() => toggle(memberRow.userId)}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {memberRow.name ?? memberRow.email}
                        </p>
                        {memberRow.name && (
                          <p className="text-muted-foreground truncate text-xs">
                            {memberRow.email}
                          </p>
                        )}
                      </div>
                      {memberRow.status === "suspended" && (
                        <Badge variant="outline" className="shrink-0 text-xs">
                          Suspended
                        </Badge>
                      )}
                    </label>
                  ))}

                  {filteredCandidates.length === 0 && (
                    <p className="text-muted-foreground py-6 text-center text-xs">
                      No members match &ldquo;{search}&rdquo;
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="border-border/50 border-t px-6 py-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            loading={saving}
            disabled={isPending || isError || !dirty}
          >
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
