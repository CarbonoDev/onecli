"use client";

import { Checkbox } from "@onecli/ui/components/checkbox";
import { cn } from "@onecli/ui/lib/utils";
import type { GranularAccessItem } from "@/lib/granular-access";

export interface ScopeChecklistProps {
  items: GranularAccessItem[];
  selectedIds: string[];
  itemLabel: { singular: string; plural: string };
  onChange: (ids: string[]) => void;
  /** Render the current selection without allowing edits (an org-granted row,
   * or a save in flight). Still VISIBLE — hiding it would make the grant look
   * unscoped. */
  readOnly?: boolean;
  /** Ids the organization's boundary permits. Anything outside is shown
   * disabled: selecting it would produce an effective scope that reaches
   * nothing. `undefined` means no boundary applies. */
  allowedIds?: string[];
}

/** Enumerable resource picker (e.g. GitHub repositories from connect-time
 * metadata): a multi-select checklist. An empty selection means "all"
 * (unrestricted) — the same as no policy. */
export const ScopeChecklist = ({
  items,
  selectedIds,
  itemLabel,
  onChange,
  readOnly = false,
  allowedIds,
}: ScopeChecklistProps): React.JSX.Element => {
  const selected = new Set(selectedIds);
  const allowed = allowedIds ? new Set(allowedIds) : null;
  const isBlocked = (id: string) => allowed !== null && !allowed.has(id);
  const toggle = (id: string) => {
    if (readOnly) return;
    const next = new Set(selected);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onChange([...next]);
  };

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {selected.size === 0
          ? `All ${itemLabel.plural} (no restriction)`
          : `Limited to ${selected.size} of ${Math.max(items.length, selected.size)} ${itemLabel.plural}`}
      </p>
      <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
        {items.map((item) => {
          const disabled = readOnly || isBlocked(item.id);
          return (
            <label
              key={item.id}
              title={
                isBlocked(item.id)
                  ? "Outside your organization's boundary for this connection"
                  : undefined
              }
              className={cn(
                "flex items-center gap-2 rounded-sm px-1 py-1 text-sm",
                disabled
                  ? "cursor-not-allowed opacity-60"
                  : "cursor-pointer hover:bg-muted",
              )}
            >
              <Checkbox
                checked={selected.has(item.id)}
                disabled={disabled}
                onCheckedChange={() => toggle(item.id)}
              />
              <span className="truncate">{item.label}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
};
