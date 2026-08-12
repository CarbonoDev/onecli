"use client";

import { useState } from "react";
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
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Both mutations are instantiated PER ROW, which is what makes
  // `verify.error` a per-row value: a check that missed on one domain must
  // never render under another.
  const verify = useVerifyDomain();
  const remove = useDeleteDomain();

  const isVerified = domain.verifiedAt !== null;

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
            aria-label={`Remove ${domain.domain}`}
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
              and a refetch does not resurrect it. */}
          {verify.error && (
            <p className="text-destructive text-xs" role="status">
              {verify.error.message}
            </p>
          )}
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
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
