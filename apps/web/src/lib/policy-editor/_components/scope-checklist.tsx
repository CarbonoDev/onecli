"use client";

import { Checkbox } from "@onecli/ui/components/checkbox";
import type { GranularAccessItem } from "@/lib/granular-access";

export interface ScopeChecklistProps {
  items: GranularAccessItem[];
  selectedIds: string[];
  itemLabel: { singular: string; plural: string };
  onChange: (ids: string[]) => void;
}

/** Enumerable resource picker (e.g. GitHub repositories from connect-time
 * metadata): a multi-select checklist. An empty selection means "all"
 * (unrestricted) — the same as no policy. */
export const ScopeChecklist = ({
  items,
  selectedIds,
  itemLabel,
  onChange,
}: ScopeChecklistProps): React.JSX.Element => {
  const selected = new Set(selectedIds);
  const toggle = (id: string) => {
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
        {items.map((item) => (
          <label
            key={item.id}
            className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-sm hover:bg-muted"
          >
            <Checkbox
              checked={selected.has(item.id)}
              onCheckedChange={() => toggle(item.id)}
            />
            <span className="truncate">{item.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
};
