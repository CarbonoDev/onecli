"use client";

import { Copy, Check } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

export interface CopyLinkButtonProps {
  token: string;
  /** Invitee address, used to name the button per row for screen readers. */
  email: string;
}

/**
 * Icon-only copy action for a pending invitation row — composes the join
 * link from the browser's own origin (D-I).
 */
export const CopyLinkButton = ({ token, email }: CopyLinkButtonProps) => {
  const { copied, copy } = useCopyToClipboard();
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8"
      title="Copy invite link"
      // aria-label (not title) supplies the accessible name, so each row in the
      // pending-invitations table announces its own invitee instead of every
      // row repeating the identical "Copy invite link".
      aria-label={`Copy invite link for ${email}`}
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
