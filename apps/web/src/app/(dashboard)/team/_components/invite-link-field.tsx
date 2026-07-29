"use client";

import { Copy, Check } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

export interface InviteLinkFieldProps {
  link: string;
}

/** Read-only join link + copy button (the api-key-card pattern). */
export const InviteLinkField = ({ link }: InviteLinkFieldProps) => {
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="flex items-center gap-2">
      <Input
        readOnly
        value={link}
        className="font-mono text-xs"
        onFocus={(e) => e.currentTarget.select()}
      />
      <Button
        variant="outline"
        size="icon"
        className="shrink-0"
        title="Copy invite link"
        onClick={() => copy(link)}
      >
        {copied ? (
          <Check className="size-4 text-brand" />
        ) : (
          <Copy className="size-4" />
        )}
      </Button>
    </div>
  );
};
