"use client";

import type { Connection } from "@/lib/api";
import { granularAccessConfigs } from "@/lib/granular-access";
import { ScopeChecklist } from "./_components/scope-checklist";
import { ScopeTextList } from "./_components/scope-text-list";

/**
 * The open-edition resource-scope editor: granular per-resource scoping (GitHub
 * repositories / Dropbox folders) on a connection's injected credential. Driven
 * by the shared `granularAccessConfigs` — a checklist for providers that
 * enumerate their resources at connect time (GitHub repos), a free-text path
 * list for those that can't (Dropbox folders). The gateway enforces the emitted
 * `{repositories}` / `{folders}` policy at the REQUEST layer
 * (`policy_engine::scope`, reached via `ee_apps::has_request_guard`).
 *
 * Self-gating: providers with no granular config, and connections that can't be
 * scoped, render nothing. Two consumers mount it — the rule editor
 * (`_components/app-target-fields.tsx`) and, per connection, the agent grant
 * dialog (`agents/[agentId]/_components/manage-permissions-dialog.tsx`).
 */

export interface ResourceScopeFieldsProps {
  connection: Connection;
  policy: Record<string, unknown> | null;
  onChange: (policy: Record<string, unknown> | null) => void;
  /** Show the scope without allowing edits — an org-granted row, or a save in
   * flight. Deliberately still RENDERED: returning null here would make the
   * Resources block vanish mid-save and make a granted scope look absent. */
  readOnly?: boolean;
  /** The organization's resource boundary for this connection
   * (`EffectiveAppPermissionsResult.orgResources`). Selections outside it are
   * disabled: they would intersect to an effective scope reaching nothing. */
  orgPolicy?: Record<string, unknown> | null;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const ResourceScopeFields = ({
  connection,
  policy,
  onChange,
  readOnly = false,
  orgPolicy = null,
}: ResourceScopeFieldsProps): React.JSX.Element | null => {
  const config = granularAccessConfigs.get(connection.provider);
  const metadata = asRecord(connection.metadata);

  // No granular axis for this provider, or this connection can't be scoped:
  // there is nothing to narrow, so render nothing (the whole connection is
  // reachable, matching a null policy).
  if (!config || !config.isSupported(metadata)) {
    return null;
  }

  const items = config.getItems(metadata);
  const selectedIds = config.getSelectedItems(policy ?? {});
  // The org ceiling, read with the same config that reads the selection.
  const boundaryIds = orgPolicy
    ? config.getSelectedItems(asRecord(orgPolicy))
    : null;
  // Coerce an empty policy to null at the emit boundary: "no restriction"
  // must clear the scope, not send `{}` — the API's strict `sessionPolicySchema`
  // rejects an empty object (it requires a `repositories`/`folders` key), so a
  // user deselecting all repos / removing all folders would otherwise 400.
  const emit = (ids: string[]) => {
    const p = config.buildPolicy(ids);
    onChange(Object.keys(p).length ? p : null);
  };

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium">Resource access</p>
      {boundaryIds && boundaryIds.length > 0 && (
        <p className="text-muted-foreground text-xs">
          Your organization limits this connection to {boundaryIds.length}{" "}
          {boundaryIds.length === 1
            ? config.itemLabel.singular
            : config.itemLabel.plural}
          .
        </p>
      )}
      {items.length > 0 ? (
        <ScopeChecklist
          items={items}
          selectedIds={selectedIds}
          itemLabel={config.itemLabel}
          onChange={emit}
          readOnly={readOnly}
          allowedIds={boundaryIds ?? undefined}
        />
      ) : (
        // Free-text (Dropbox folders): a set-difference against the boundary
        // would be wrong here, since folder scopes nest by prefix — `/a` covers
        // `/a/b`. The note above states the ceiling; the gateway intersects.
        <ScopeTextList
          values={selectedIds}
          itemLabel={config.itemLabel}
          placeholder={`Add a ${config.itemLabel.singular}…`}
          validate={config.validateEntry}
          onChange={emit}
          readOnly={readOnly}
        />
      )}
    </div>
  );
};
