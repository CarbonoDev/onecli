"use client";

import { useEffect, useState, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Plus, KeyRound, Lock } from "lucide-react";
import { apiGet, secretsPath, type PageScope } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { SecretCard } from "./secret-card";
import { SecretDialog, type SecretPrefill } from "./secret-dialog";
import { defaultSecretActionsFor } from "./secret-actions";
import type { SecretActions } from "./types";
import { safeDecode } from "./safe-decode";
import { labelForScope, type ScopeLabelMap } from "./scope-label";

interface Secret {
  id: string;
  name: string;
  type: string;
  typeLabel: string;
  valueSource?: string;
  opRef?: string | null;
  hostPattern: string;
  pathPattern: string | null;
  injectionConfig: unknown;
  metadata: Record<string, unknown> | null;
  scope?: string | null;
  createdAt: Date;
}

interface SecretsContentProps {
  typeFilter: "generic" | "llm";
  getSecrets?: () => Promise<Secret[]>;
  secretActions?: SecretActions;
  pageScope?: PageScope;
  scopeLabels?: ScopeLabelMap;
  renderCreateButton?: (onCreate: () => void) => React.ReactNode;
}

export const SecretsContent = ({
  typeFilter,
  getSecrets,
  secretActions,
  pageScope = "project",
  scopeLabels,
  renderCreateButton,
}: SecretsContentProps) => {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Org scope writes over HTTP (`/v1/org/secrets`); project scope keeps the
  // audited server actions the card and dialog default to on their own.
  const actions = secretActions ?? defaultSecretActionsFor(pageScope);
  const {
    data: secrets = [],
    isPending: loading,
    isError,
  } = useQuery<Secret[]>({
    queryKey: queryKeys.secrets.list(pageScope),
    queryFn: getSecrets ?? (() => apiGet<Secret[]>(secretsPath(pageScope))),
    // The org route is admin-gated; a member's 403 is deterministic, so it is
    // rendered rather than retried. Project reads keep the library default.
    retry: pageScope === "organization" ? false : undefined,
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [prefill, setPrefill] = useState<SecretPrefill | undefined>();
  const paramHandled = useRef(false);

  const allFiltered = secrets.filter((s: Secret) =>
    typeFilter === "generic" ? s.type === "generic" : s.type !== "generic",
  );
  const ownSecrets = allFiltered.filter(
    (s: Secret) => s.scope === pageScope || !s.scope,
  );
  const inheritedSecrets = allFiltered.filter(
    (s: Secret) => s.scope && s.scope !== pageScope,
  );

  useEffect(() => {
    if (paramHandled.current || loading) return;
    const createType = searchParams.get("create");
    const host = searchParams.get("host");
    const action = searchParams.get("action");
    if (action === "new") {
      paramHandled.current = true;
      setCreateOpen(true);
      router.replace(window.location.pathname, { scroll: false });
    } else if (createType === "anthropic" && typeFilter === "llm") {
      paramHandled.current = true;
      setPrefill({
        type: "anthropic",
        hostPattern: "api.anthropic.com",
        name: "Anthropic Token",
      });
      setCreateOpen(true);
      router.replace(window.location.pathname, { scroll: false });
    } else if (createType === "openai" && typeFilter === "llm") {
      paramHandled.current = true;
      setPrefill({
        type: "openai",
        hostPattern: "api.openai.com",
        name: "OpenAI Token",
      });
      setCreateOpen(true);
      router.replace(window.location.pathname, { scroll: false });
    } else if (createType === "codex" && typeFilter === "llm") {
      paramHandled.current = true;
      setPrefill({
        type: "openai",
        hostPattern: "chatgpt.com",
        name: "Codex Token",
      });
      setCreateOpen(true);
      router.replace(window.location.pathname, { scroll: false });
    } else if (createType === "generic" && typeFilter === "generic" && host) {
      paramHandled.current = true;
      setPrefill({
        type: "generic",
        hostPattern: host,
        pathPattern: safeDecode(searchParams.get("path")),
        name: safeDecode(searchParams.get("name")) ?? `${host} Secret`,
        headerName: safeDecode(searchParams.get("header")),
        valueFormat: safeDecode(searchParams.get("format")),
        paramName: safeDecode(searchParams.get("param")),
        paramFormat: safeDecode(searchParams.get("paramFormat")),
      });
      setCreateOpen(true);
      router.replace(window.location.pathname, { scroll: false });
    }
  }, [searchParams, loading, router, typeFilter]);

  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2].map((i) => (
          <Card key={i} className="p-6">
            <div className="flex items-center justify-between">
              <div className="space-y-2">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-4 w-56" />
                <Skeleton className="h-4 w-32" />
              </div>
              <div className="flex gap-2">
                <Skeleton className="size-8 rounded-md" />
                <Skeleton className="size-8 rounded-md" />
              </div>
            </div>
          </Card>
        ))}
      </div>
    );
  }

  // A member reaching an org page gets a deterministic 403 on every read. Not a
  // plan gate and not an error state — a role boundary, so it says who can do
  // this and stops. (Only org scope: a project read failing is a real error and
  // keeps its existing empty rendering.)
  //
  // `Lock`, matching the /groups and /team admin-only notices. The lock here
  // reads as "you can't do this", not "buy a bigger plan" — there are no plan
  // tiers to sell, and three admin-only cards must not disagree on iconography.
  if (isError && pageScope === "organization") {
    return (
      <EmptyState
        variant="card"
        icon={Lock}
        title="Admins only"
        description={
          typeFilter === "llm"
            ? "Organization LLM keys are managed by organization admins. Ask an admin if you need one added or changed."
            : "Organization secrets are managed by organization admins. Ask an admin if you need one added or changed."
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        {renderCreateButton ? (
          renderCreateButton(() => setCreateOpen(true))
        ) : (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5" />
            {typeFilter === "llm" ? "Add LLM Key" : "Add Secret"}
          </Button>
        )}
      </div>

      {ownSecrets.length === 0 && inheritedSecrets.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          things={typeFilter === "llm" ? "LLM keys" : "custom secrets"}
          description={
            typeFilter === "llm"
              ? "Add an LLM API key to route requests through the gateway."
              : "Add a custom secret to inject encrypted credentials into gateway requests."
          }
        />
      ) : (
        <>
          {ownSecrets.map((secret) => (
            <SecretCard
              key={secret.id}
              secret={secret}
              secretActions={actions}
              pageScope={pageScope}
            />
          ))}
          {inheritedSecrets.map((secret) => (
            <SecretCard
              key={`inherited-${secret.id}`}
              secret={secret}
              readOnly
              badge={labelForScope(secret.scope, scopeLabels)}
            />
          ))}
        </>
      )}

      <SecretDialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) setPrefill(undefined);
        }}
        prefill={prefill}
        defaultType={typeFilter === "generic" ? "generic" : undefined}
        allowedTypes={
          typeFilter === "llm" ? ["anthropic", "openai"] : undefined
        }
        secretActions={actions}
        pageScope={pageScope}
      />
    </div>
  );
};
