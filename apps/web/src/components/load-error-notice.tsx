"use client";

import { TriangleAlert } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { EmptyState, type EmptyStateProps } from "@/components/empty-state";

export interface LoadErrorNoticeProps {
  /** `Couldn't load <the thing>` — names what failed, not why. */
  title: string;
  message: string;
  onRetry: () => void;
  /**
   * `card` when the notice REPLACES the whole surface (the domains page);
   * `dashed` when it sits inside one that already has a frame — a card body,
   * a section. Defaults to `card`, matching `EmptyState`.
   */
  variant?: EmptyStateProps["variant"];
}

/**
 * A read failed for a reason that is NOT a settled authorization answer.
 *
 * Kept separate from the admin-only / forbidden notices because collapsing
 * every error into "Admins only" tells someone staring at a 500, a dropped
 * session, or a dead API container that they lack a permission they actually
 * hold — and hides the one thing that would help. Where the failure comes
 * through the API client, `ApiError.status` is what lets a surface tell an
 * expected 403 from a transport failure. Unlike a 403, this one is worth
 * retrying, so it offers the button.
 */
export const LoadErrorNotice = ({
  title,
  message,
  onRetry,
  variant = "card",
}: LoadErrorNoticeProps) => (
  <EmptyState
    variant={variant}
    icon={TriangleAlert}
    title={title}
    description={message}
    action={
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    }
  />
);
