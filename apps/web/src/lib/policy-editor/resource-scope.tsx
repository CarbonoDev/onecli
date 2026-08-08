"use client";

import type { Connection } from "@/lib/api";
import { granularAccessConfigs } from "@/lib/granular-access";
import { ScopeChecklist } from "./_components/scope-checklist";
import { ScopeTextList } from "./_components/scope-text-list";

/**
 * The OSS resource-scope editor: granular per-resource scoping (GitHub
 * repositories / Dropbox folders) on a connection's injected credential. Driven
 * by the shared `granularAccessConfigs` — a checklist for providers that
 * enumerate their resources at connect time (GitHub repos), a free-text path
 * list for those that can't (Dropbox folders). The gateway enforces the emitted
 * `{repositories}` / `{folders}` policy (`policy_engine::scope`).
 *
 * Rendered only where scoping is meaningful (a single specific connection on an
 * Allow without behavioral conditions — see the consumer in
 * `_components/app-target-fields.tsx`). Providers with no granular config, or a
 * connection that can't be scoped, render nothing. The EE editions alias this
 * file to `@/ee/policy-editor/resource-scope`.
 */

export interface ResourceScopeFieldsProps {
  connection: Connection;
  policy: Record<string, unknown> | null;
  onChange: (policy: Record<string, unknown> | null) => void;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const ResourceScopeFields = ({
  connection,
  policy,
  onChange,
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
      {items.length > 0 ? (
        <ScopeChecklist
          items={items}
          selectedIds={selectedIds}
          itemLabel={config.itemLabel}
          onChange={emit}
        />
      ) : (
        <ScopeTextList
          values={selectedIds}
          itemLabel={config.itemLabel}
          placeholder={`Add a ${config.itemLabel.singular}…`}
          validate={config.validateEntry}
          onChange={emit}
        />
      )}
    </div>
  );
};
