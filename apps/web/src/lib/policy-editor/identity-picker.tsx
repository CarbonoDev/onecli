"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@onecli/ui/components/popover";
import { useGroups } from "@/hooks/use-groups";
import { useOrgMembersList } from "@/hooks/use-org-members";
import type { ProjectionIdentity } from "@/lib/api";
import {
  IdentityPickerSection,
  type IdentityPickerRow,
} from "./_components/identity-picker-section";

/**
 * The OSS identity-picker seam. OSS mounts the organization policy scope
 * (`/v1/org/policy`) and the Rust gateway ENFORCES org rules against a resolved
 * principal set (`policy_engine/{loaders,assemble,evaluate}.rs`), so this
 * picker authors real, enforced targeting.
 *
 * It offers exactly the identity kinds the API accepts at org scope and the
 * gateway matches: `user`, `group`, and "none" (= any agent). Specific AGENTS
 * are deliberately absent — `assertIdentitiesValid` 422s an `agent` identity on
 * an org rule in every edition, so offering them would build a selection the
 * server rejects. There is no agent-group kind on this base.
 *
 * The EE editions alias this file to `@/ee/policy-editor/identity-picker`; the
 * path and the export name are the turbopack alias key
 * (`next.config.js` → `POLICY_EDITOR_ALIASES`) and must not move or change
 * shape.
 */

export interface OrgIdentityPickerProps {
  value: ProjectionIdentity[];
  onChange: (next: ProjectionIdentity[]) => void;
  /** Id for the trigger, so a field <Label htmlFor> associates with the picker. */
  id?: string;
}

type DirectoryKind = "user" | "group";

/** Proxied traffic carries NO connecting-user identity — `ProxyContext` is
 * agent-only. A `user` / `group` principal therefore resolves to the projects
 * that person (or group) can access, and matches EVERY agent in them. Said
 * plainly here rather than left for an operator to discover from a block. */
const AUDIENCE_NOTE =
  "Matches any agent in a project this person or group can access — proxied requests carry no signed-in user.";

const ALL_AGENTS_LABEL = "All agents in the organization";
/** How many chips the trigger shows before collapsing into a "+N". */
const CHIP_LIMIT = 3;

/** Placeholder chip text for a principal whose directory never loaded — the
 * kind is known from the identity row, the name is not. */
const KIND_LABEL: Record<DirectoryKind, string> = {
  group: "Group",
  user: "Person",
};

const idsOfKind = (value: ProjectionIdentity[], kind: DirectoryKind) =>
  new Set(value.flatMap((i) => (i.type === kind ? [i.id] : [])));

const matches = (q: string, ...fields: (string | null | undefined)[]) =>
  !q || fields.some((f) => (f ?? "").toLowerCase().includes(q));

export const OrgIdentityPicker = ({
  value,
  onChange,
  id,
}: OrgIdentityPickerProps) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  // Both feeds are the admin-only directories and both are `retry: false`, so a
  // non-admin's 403 is deterministic and cheap. Only fetched while the popover
  // is open — the rule drawer mounts this for every org rule, and the
  // directories are otherwise unused there.
  const groups = useGroups(open);
  const members = useOrgMembersList(open);

  const groupRows = useMemo(() => groups.data ?? [], [groups.data]);
  // Kept COMPLETE (suspended included) — it is what resolves chip names, and a
  // suspended teammate an older rule already names must render as themselves,
  // not as "Unknown (removed)". The selectable set is narrowed below.
  const memberRows = useMemo(() => members.data ?? [], [members.data]);

  // Every directory failed → there is nothing to pick from. NOT gated on
  // `open`: the notice under the trigger has to survive the popover closing,
  // else the picker silently reads "All agents in the organization" with no
  // hint that the feeds failed.
  const allFailed = groups.isError && members.isError;
  /** Per-kind resolution: a chip is only "removed" when ITS OWN directory
   * loaded and did not contain it. One feed succeeding says nothing about the
   * other. */
  const loaded: Record<DirectoryKind, boolean> = {
    group: groups.isSuccess,
    user: members.isSuccess,
  };

  const selected = useMemo(
    () => ({
      group: idsOfKind(value, "group"),
      user: idsOfKind(value, "user"),
    }),
    [value],
  );

  const toggle = (type: DirectoryKind, rowId: string) => {
    const present = value.some((i) => i.type === type && i.id === rowId);
    onChange(
      present
        ? value.filter((i) => !(i.type === type && i.id === rowId))
        : [...value, { type, id: rowId }],
    );
  };

  const q = search.trim().toLowerCase();

  const groupOptions: IdentityPickerRow[] = groupRows
    .filter((g) => matches(q, g.name))
    .map((g) => ({
      id: g.id,
      label: g.name,
      hint: `${g.memberCount} member${g.memberCount === 1 ? "" : "s"}`,
    }));
  // SUSPENDED members are not OFFERED: `assertIdentitiesValid` counts users
  // with `status: { not: "suspended" }` and 422s a miss with the generic "A
  // referenced identity does not belong to this organization", so picking one
  // would build a selection the server refuses — for a reason the toast gets
  // wrong. One already on the rule stays listed (labelled), so it can be
  // unselected — which is exactly what makes the rule saveable again.
  const memberOptions: IdentityPickerRow[] = memberRows
    .filter((m) => m.status !== "suspended" || selected.user.has(m.userId))
    .filter((m) => matches(q, m.email, m.name))
    .map((m) => ({
      id: m.userId,
      label: m.name ?? m.email,
      hint:
        m.status === "suspended"
          ? "Suspended — remove to save this rule"
          : m.name
            ? m.email
            : null,
    }));

  const nameOf = (identity: ProjectionIdentity): string | null => {
    switch (identity.type) {
      case "group":
        return groupRows.find((g) => g.id === identity.id)?.name ?? null;
      case "user": {
        const row = memberRows.find((m) => m.userId === identity.id);
        return row ? (row.name ?? row.email) : null;
      }
      default:
        return null;
    }
  };

  /**
   * A chip's text and whether it may claim the principal is GONE. "Removed" is
   * asserted only when the principal's OWN directory loaded and did not contain
   * it — the visible face of the identity cascade (the server disables
   * wholly-orphaned rules, but a multi-principal rule keeps its remaining
   * targets and loses this one). A directory that 403'd or failed in transport
   * renders a neutral kind placeholder instead: the principal exists, this
   * build just cannot name it.
   */
  const chip = (
    identity: ProjectionIdentity,
  ): { label: string; removed: boolean; title?: string } => {
    const kind = identity.type;
    if (kind !== "group" && kind !== "user")
      return { label: identity.id, removed: false };
    if (!loaded[kind])
      return {
        label: KIND_LABEL[kind],
        removed: false,
        title:
          "Still targeted — this directory could not be loaded, so its name is unavailable.",
      };
    const name = nameOf(identity);
    return name
      ? { label: name, removed: false }
      : {
          label: "Unknown (removed)",
          removed: true,
          title:
            "This principal no longer exists — the rule no longer targets it.",
        };
  };
  // NOTHING loaded (no feed has succeeded yet) → render the count rather than a
  // row of bare kind placeholders.
  const resolvable = loaded.group || loaded.user;

  const shown = value.slice(0, CHIP_LIMIT);
  const overflow = value.length - shown.length;

  return (
    <div className="space-y-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            // Locked only while CLOSED: disabling an open popover's trigger
            // would leave Escape / outside-click as the only way to close it.
            disabled={allFailed && !open}
            className="h-auto w-full justify-start py-2 font-normal"
          >
            {value.length === 0 ? (
              <span className="text-muted-foreground">{ALL_AGENTS_LABEL}</span>
            ) : !resolvable ? (
              <span>{value.length} selected</span>
            ) : (
              <span className="flex flex-wrap items-center gap-1">
                {shown.map((identity) => {
                  const { label, removed, title } = chip(identity);
                  return (
                    <Badge
                      key={`${identity.type}:${identity.id}`}
                      variant={removed ? "destructive" : "secondary"}
                      title={title}
                    >
                      {label}
                    </Badge>
                  );
                })}
                {overflow > 0 && (
                  <span className="text-muted-foreground text-xs">
                    +{overflow}
                  </span>
                )}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[22rem] p-0">
          <div className="space-y-2 border-b p-2">
            <div className="relative">
              <Search
                className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
                aria-hidden="true"
              />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter groups, people..."
                aria-label="Filter identities"
                className="h-8 pl-8 text-sm"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="flex items-center justify-between px-1">
              <p className="text-muted-foreground text-xs" aria-live="polite">
                {value.length === 0
                  ? ALL_AGENTS_LABEL
                  : `${value.length} selected`}
              </p>
              <button
                type="button"
                onClick={() => onChange([])}
                disabled={value.length === 0}
                className="text-muted-foreground hover:text-foreground text-xs transition-colors disabled:opacity-50"
              >
                Clear (all agents)
              </button>
            </div>
          </div>

          <div className="max-h-[min(22rem,50vh)] space-y-3 overflow-y-auto p-2">
            <IdentityPickerSection
              type="group"
              title="Groups (project audience)"
              note={AUDIENCE_NOTE}
              rows={groupOptions}
              selected={selected.group}
              onToggle={toggle}
              emptyLabel={
                groupRows.length === 0
                  ? "No groups yet — create one on the Groups page."
                  : `No groups match “${search.trim()}”`
              }
              // Both feeds drain every page, so the "none yet" copy would
              // otherwise assert an empty directory while the read is still in
              // flight.
              pending={groups.isPending}
              failed={groups.isError}
            />
            <IdentityPickerSection
              type="user"
              title="People (project audience)"
              // The People semantics are the more surprising of the two
              // ("block Alice" blocks every agent in every project Alice can
              // reach), so they carry the caveat too.
              note={AUDIENCE_NOTE}
              rows={memberOptions}
              selected={selected.user}
              onToggle={toggle}
              emptyLabel={
                memberRows.length === 0
                  ? "No members yet — invite teammates from the Team page."
                  : `No people match “${search.trim()}”`
              }
              pending={members.isPending}
              failed={members.isError}
            />
          </div>
        </PopoverContent>
      </Popover>
      {allFailed && (
        <p className="text-muted-foreground text-xs">
          Organization directories are admin-only.{" "}
          {value.length === 0
            ? "This rule applies to all agents in the organization."
            : "This rule's existing targets are preserved, but they can't be listed or changed here."}
        </p>
      )}
    </div>
  );
};
