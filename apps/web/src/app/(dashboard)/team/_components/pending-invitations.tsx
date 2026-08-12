"use client";

import { useState } from "react";
import { Trash2, Loader2, Mail, TriangleAlert } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Badge } from "@onecli/ui/components/badge";
import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@onecli/ui/components/table";
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
import { cn } from "@onecli/ui/lib/utils";
import { EmptyState } from "@/components/empty-state";
import { TableCard } from "@/components/table-card";
import { useRevokeInvitation } from "@/hooks/use-invitations";
import type { InvitationRow } from "@/lib/api";
import { CopyLinkButton } from "./copy-link-button";

export interface PendingInvitationsProps {
  invitations: InvitationRow[];
  loading: boolean;
  /** Fetch failed — must not masquerade as the "no invitations" empty state. */
  error?: boolean;
}

const statusBadgeVariant = (status: InvitationRow["status"]) =>
  status === "pending"
    ? ("secondary" as const)
    : status === "expired" || status === "cancelled"
      ? ("outline" as const)
      : ("default" as const);

/** "in 6d" / "in 3h" / "expired" — expiry is in the future, unlike formatRelative. */
const formatExpiry = (expiresAt: string) => {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return "expired";
  const hours = Math.floor(diff / (60 * 60 * 1000));
  if (hours < 1) return "in <1h";
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
};

export const PendingInvitations = ({
  invitations,
  loading,
  error = false,
}: PendingInvitationsProps) => {
  const [revokeTarget, setRevokeTarget] = useState<InvitationRow | null>(null);
  const revoke = useRevokeInvitation();

  const handleRevoke = () => {
    if (!revokeTarget) return;
    revoke.mutate(revokeTarget.id, {
      onSuccess: () => setRevokeTarget(null),
    });
  };

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium">Invitations</h2>
      {loading ? (
        <Card className="p-6">
          <div className="space-y-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-64" />
          </div>
        </Card>
      ) : error ? (
        <Card className="flex items-start gap-2 p-4">
          <TriangleAlert className="text-destructive mt-0.5 size-4 shrink-0" />
          <div>
            <p className="text-sm font-medium">
              Couldn&apos;t load invitations
            </p>
            <p className="text-muted-foreground mt-1 text-xs">
              Something went wrong fetching the invitation list. Refresh the
              page to try again.
            </p>
          </div>
        </Card>
      ) : invitations.length === 0 ? (
        <EmptyState
          variant="dashed"
          icon={Mail}
          things="invitations"
          description="Invite a teammate to generate a join link you can send them."
        />
      ) : (
        <TableCard>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Invited by</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {invitations.map((row) => {
                const inactive = row.status !== "pending";
                return (
                  <TableRow
                    key={row.id}
                    className={cn(inactive && "text-muted-foreground")}
                  >
                    <TableCell className="font-medium">{row.email}</TableCell>
                    <TableCell>{row.role}</TableCell>
                    <TableCell>{row.invitedByEmail}</TableCell>
                    <TableCell>
                      {row.status === "pending"
                        ? formatExpiry(row.expiresAt)
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusBadgeVariant(row.status)}>
                        {row.status === "cancelled" ? "revoked" : row.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        {/* The link is only actionable while pending. */}
                        {row.status === "pending" && (
                          <>
                            <CopyLinkButton
                              token={row.token}
                              email={row.email}
                            />
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8"
                              title="Revoke invitation"
                              aria-label={`Revoke invitation for ${row.email}`}
                              onClick={() => setRevokeTarget(row)}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableCard>
      )}

      <AlertDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Revoke the invitation for {revokeTarget?.email}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The join link stops working immediately. You can invite this
              address again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoke.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleRevoke();
              }}
              disabled={revoke.isPending}
            >
              {revoke.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Revoking...
                </>
              ) : (
                "Revoke"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
