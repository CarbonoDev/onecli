"use client";

import { TriangleAlert } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { EmptyState } from "@/components/empty-state";

export interface LoadErrorNoticeProps {
  message: string;
  onRetry: () => void;
}

/**
 * The domains list failed for a reason that is NOT a 403.
 *
 * Kept separate from `AdminOnlyNotice` because collapsing every error into
 * "Admins only" tells an admin staring at a 500, a dropped session, or a dead
 * API container that they lack a permission they actually hold — and hides the
 * one thing that would help. `ApiError` carries `.status` precisely so a
 * surface can tell an expected 403 from a transport failure. Unlike the 403,
 * this one is worth retrying, so it offers the button.
 */
export const LoadErrorNotice = ({ message, onRetry }: LoadErrorNoticeProps) => (
  <EmptyState
    variant="card"
    icon={TriangleAlert}
    title="Couldn't load domains"
    description={message}
    action={
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    }
  />
);
