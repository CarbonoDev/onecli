"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";

export interface ScopeTextListProps {
  values: string[];
  itemLabel: { singular: string; plural: string };
  placeholder?: string;
  /** Provider-specific format validator: returns an error message for an entry
   * the gateway parser can't enforce, or `null`/`undefined` when acceptable.
   * Invalid entries are refused with an inline error rather than added — an
   * unenforceable entry would silently brick or no-op the restriction. */
  validate?: (value: string) => string | null;
  onChange: (values: string[]) => void;
}

/** Free-text resource list for providers that can't be enumerated at
 * connect time (e.g. Dropbox folders): one path per row, add/remove. An empty
 * list means "all" (unrestricted). */
export const ScopeTextList = ({
  values,
  itemLabel,
  placeholder,
  validate,
  onChange,
}: ScopeTextListProps): React.JSX.Element => {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    const value = draft.trim();
    if (!value) {
      setDraft("");
      setError(null);
      return;
    }
    if (values.includes(value)) {
      setDraft("");
      setError(null);
      return;
    }
    const validationError = validate?.(value) ?? null;
    if (validationError) {
      setError(validationError);
      return;
    }
    onChange([...values, value]);
    setDraft("");
    setError(null);
  };

  const remove = (value: string) =>
    onChange(values.filter((entry) => entry !== value));

  return (
    <div className="space-y-2">
      {values.length > 0 ? (
        <ul className="space-y-1">
          {values.map((value) => (
            <li
              key={value}
              className="flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-xs"
            >
              <span className="truncate font-mono">{value}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label={`Remove ${itemLabel.singular} ${value}`}
                onClick={() => remove(value)}
              >
                <X className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          All {itemLabel.plural} (no restriction)
        </p>
      )}
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          placeholder={placeholder}
          aria-label={`Add a ${itemLabel.singular}`}
          aria-invalid={error != null}
          onChange={(event) => {
            setDraft(event.target.value);
            if (error) {
              setError(null);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!draft.trim()}
          onClick={add}
        >
          <Plus className="size-3.5" />
          Add
        </Button>
      </div>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
};
