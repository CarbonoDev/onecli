"use client";

import { Checkbox } from "@onecli/ui/components/checkbox";
import type { ProjectionIdentity } from "@/lib/api";

/** One selectable directory row: a stable id, a display label, and an optional
 * second line (member counts / emails). */
export interface IdentityPickerRow {
  id: string;
  label: string;
  hint?: string | null;
}

export interface IdentityPickerSectionProps {
  /** The identity kind every row in this section produces. */
  type: Extract<ProjectionIdentity["type"], "user" | "group">;
  title: string;
  /** The "project audience" caveat, rendered under People / Groups. */
  note?: string;
  rows: IdentityPickerRow[];
  selected: Set<string>;
  onToggle: (type: IdentityPickerSectionProps["type"], id: string) => void;
  /** Shown instead of the rows when the section resolved to nothing. */
  emptyLabel: string;
  /** The section's directory read is still in flight. Distinct from an empty
   * directory: `emptyLabel` asserts the org HAS no groups/people, which would
   * be a false statement (and a wrong call to action) while loading. */
  pending?: boolean;
  /** The section's directory read failed (a non-admin's 403, typically). */
  failed: boolean;
}

/**
 * One labelled block of the org identity picker. Kept in its own file (one
 * component per file) and deliberately dumb: the picker owns the selection,
 * the search filter, and every query.
 */
export const IdentityPickerSection = ({
  type,
  title,
  note,
  rows,
  selected,
  onToggle,
  emptyLabel,
  pending = false,
  failed,
}: IdentityPickerSectionProps) => (
  <div className="space-y-1.5">
    <p className="text-muted-foreground px-1 text-xs font-medium">{title}</p>
    {note && <p className="text-muted-foreground px-1 text-xs">{note}</p>}
    {failed ? (
      <p className="text-muted-foreground px-1 py-1 text-xs">
        Not available — organization directories are admin-only.
      </p>
    ) : pending ? (
      <p
        className="text-muted-foreground px-1 py-1 text-xs"
        role="status"
        aria-live="polite"
      >
        Loading…
      </p>
    ) : rows.length === 0 ? (
      <p className="text-muted-foreground px-1 py-1 text-xs">{emptyLabel}</p>
    ) : (
      <div className="divide-border divide-y rounded-md border">
        {rows.map((row) => {
          const inputId = `identity-${type}-${row.id}`;
          return (
            <div
              key={row.id}
              className="hover:bg-muted/50 flex items-center gap-2.5 px-2.5 py-2 transition-colors"
            >
              <Checkbox
                id={inputId}
                checked={selected.has(row.id)}
                onCheckedChange={() => onToggle(type, row.id)}
              />
              <label
                htmlFor={inputId}
                className="min-w-0 flex-1 cursor-pointer"
              >
                <span className="block truncate text-sm">{row.label}</span>
                {row.hint && (
                  <span className="text-muted-foreground block truncate text-xs">
                    {row.hint}
                  </span>
                )}
              </label>
            </div>
          );
        })}
      </div>
    )}
  </div>
);
