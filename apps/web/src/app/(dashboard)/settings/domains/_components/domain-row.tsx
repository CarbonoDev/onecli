"use client";

import { useEffect, useId, useState } from "react";
import { CheckCircle2, Clock, Loader2, Trash2 } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@onecli/ui/components/alert-dialog";
import { useDeleteDomain, useVerifyDomain } from "@/hooks/use-domains";
import type { OrgDomainRow } from "@/lib/api";
import { DnsRecordField } from "./dns-record-field";

export interface DomainRowProps {
  domain: OrgDomainRow;
}

export const DomainRow = ({ domain }: DomainRowProps) => {
  const errorId = useId();
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Both mutations are instantiated PER ROW, which is what makes
  // `verify.error` a per-row value: a check that missed on one domain must
  // never render under another.
  const verify = useVerifyDomain();
  const remove = useDeleteDomain();

  const isVerified = domain.verifiedAt !== null;
  const checkError = verify.error?.message ?? null;

  // A failed check is an OBSERVATION, and observations go stale. The row is
  // untouched by a miss, so React Query's structural sharing keeps the same
  // data identity across a refetch and nothing else would ever clear this —
  // leaving "No matching TXT record found" sitting under a record the user has
  // since published correctly. Returning to the tab is exactly the moment they
  // come back from their DNS panel, so that is where the stale reading is
  // dropped. `reset` is a stable react-query callback, so this subscribes once.
  const { reset } = verify;
  useEffect(() => {
    window.addEventListener("focus", reset);
    return () => window.removeEventListener("focus", reset);
  }, [reset]);

  return (
    <div className="rounded-lg border">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{domain.domain}</span>
          {isVerified ? (
            <Badge variant="secondary" className="shrink-0 gap-1">
              <CheckCircle2 className="text-brand size-3" aria-hidden />
              Verified
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="text-muted-foreground shrink-0 gap-1"
            >
              <Clock className="size-3" aria-hidden />
              Pending
            </Badge>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!isVerified && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => verify.mutate(domain.id)}
              disabled={verify.isPending}
              // Points the button at the reason its last press failed, so the
              // control and its outcome are one thing to a screen reader.
              aria-describedby={checkError ? errorId : undefined}
            >
              {verify.isPending ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Checking...
                </>
              ) : (
                "Verify"
              )}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            // Icon-only, so the label IS the button's text — CLAUDE.md's
            // loading rule ("update the text") applies to it, not to a caption
            // that doesn't exist.
            aria-label={
              remove.isPending
                ? `Removing ${domain.domain}...`
                : `Remove ${domain.domain}`
            }
            onClick={() => setConfirmOpen(true)}
            disabled={remove.isPending}
          >
            {remove.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
          </Button>
        </div>
      </div>

      {/* A pending row expands to show exactly what to publish. Verified rows
          collapse it away: the record has already done its job, and leaving it
          on screen invites someone to delete it as clutter. */}
      {!isVerified && (
        <div className="space-y-3 border-t px-4 py-3">
          <p className="text-muted-foreground text-xs">
            Add this TXT record to your DNS, then check again.
          </p>
          <DnsRecordField label="Name" value={domain.recordName} />
          <DnsRecordField label="Value" value={domain.recordValue} />
          {/* The failed CHECK, held here and nowhere else — it is what one
              lookup saw, not a state the domain is in, so nothing persists it
              and a refetch does not resurrect it.

              ALWAYS MOUNTED, and `alert` rather than `status`. A live region
              that appears together with its own text is usually announced by
              nothing: the region has to already exist for the insertion to
              count as a change. `empty:hidden` keeps it out of the layout while
              it has nothing to say, and `alert` (assertive) is right because
              this is the direct result of the press the user just made. */}
          <p
            id={errorId}
            role="alert"
            className="text-destructive text-xs empty:hidden"
          >
            {checkError}
          </p>
        </div>
      )}

      {/* Not dismissable mid-flight: closing it while the DELETE is in the air
          hides the outcome of a request that is still going to land. */}
      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!remove.isPending) setConfirmOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {domain.domain}?</AlertDialogTitle>
            <AlertDialogDescription>
              {isVerified
                ? "This gives up proven ownership. Anyone — in any organization — can claim this domain afterwards, and you would have to publish a new TXT record to get it back."
                : "This releases the claim and retires its TXT record. Claiming the domain again issues a new record to publish."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                remove.mutate(domain.id, {
                  onSuccess: () => setConfirmOpen(false),
                });
              }}
              disabled={remove.isPending}
            >
              {remove.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Removing...
                </>
              ) : (
                "Remove"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
