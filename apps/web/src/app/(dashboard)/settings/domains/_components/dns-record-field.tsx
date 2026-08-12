"use client";

import { Check, Copy } from "lucide-react";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

export interface DnsRecordFieldProps {
  /** What the DNS provider's form calls this box ("Name", "Value"). */
  label: string;
  value: string;
}

/**
 * One read-only field of the TXT record, copyable on its own.
 *
 * Separately copyable per field, not one blob: every DNS provider's form has a
 * distinct Name box and Value box, and a caller pasting `name value` into
 * either one publishes a record that will never match. Same read-only-code
 * shape as the instance page's Public URL card.
 */
export const DnsRecordField = ({ label, value }: DnsRecordFieldProps) => {
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="space-y-1">
      <p className="text-muted-foreground text-[11px] font-medium tracking-wider uppercase">
        {label}
      </p>
      <div className="flex items-center gap-2">
        <div className="bg-muted/50 flex min-w-0 flex-1 items-center rounded-md border px-3 py-2">
          {/* `break-all`, not `truncate`: the value is what has to be typed
              into a DNS panel, so hiding half of it behind an ellipsis would
              make the field unusable for anyone who copies by hand. */}
          <code className="min-w-0 flex-1 font-mono text-xs break-all">
            {value}
          </code>
        </div>
        <button
          type="button"
          onClick={() => copy(value)}
          aria-label={
            copied ? `${label} copied` : `Copy ${label.toLowerCase()}`
          }
          className="text-muted-foreground hover:text-foreground shrink-0 rounded-md border p-2 transition-colors"
        >
          {copied ? (
            <Check className="text-brand size-4" aria-hidden />
          ) : (
            <Copy className="size-4" aria-hidden />
          )}
        </button>
      </div>
    </div>
  );
};
