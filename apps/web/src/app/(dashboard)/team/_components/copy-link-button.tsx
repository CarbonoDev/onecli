"use client";

import { Copy, Check } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

export interface CopyLinkButtonProps {
  token: string;
  /**
   * Accessible name AND tooltip — they must be the same string (WCAG 2.5.3).
   * Several of these sit in one table, so the caller names the row ("Copy the
   * invite link for a@b.c"); "Copy invite link" alone would give every row the
   * same name.
   */
  label?: string;
}

/**
 * Icon-only copy action for a pending invitation row — composes the join
 * link from the browser's own origin (D-I).
 */
export const CopyLinkButton = ({
  token,
  label = "Copy invite link",
}: CopyLinkButtonProps) => {
  const { copied, copy } = useCopyToClipboard();
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8"
      title={label}
      aria-label={label}
      onClick={() => copy(`${window.location.origin}/join/${token}`)}
    >
      {copied ? (
        <Check className="size-4 text-brand" />
      ) : (
        <Copy className="size-4" />
      )}
    </Button>
  );
};
