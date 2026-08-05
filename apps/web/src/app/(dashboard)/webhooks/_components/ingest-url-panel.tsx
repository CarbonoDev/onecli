"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { IS_CLOUD } from "@/lib/env";
import { TestCommand } from "./test-command";

export interface IngestUrlPanelProps {
  ingestUrl: string;
  verification: string;
  secret: string | null;
}

const CopyButton = ({ value }: { value: string }) => {
  const { copied, copy } = useCopyToClipboard();
  return (
    <button
      type="button"
      onClick={() => copy(value)}
      className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
      aria-label="Copy"
    >
      {copied ? (
        <Check className="text-brand size-3.5" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </button>
  );
};

const SECRET_LABELS: Record<string, string> = {
  github: "Paste into GitHub's Secret field.",
  token: "Send as an X-Webhook-Token header, or as ?token= on the URL.",
};

/**
 * The setup checklist, top to bottom: where to paste the URL, the secret that
 * goes with it, the content type that trips everyone up, and a command to prove
 * the whole path works.
 */
export const IngestUrlPanel = ({
  ingestUrl,
  verification,
  secret,
}: IngestUrlPanelProps) => {
  const [revealed, setRevealed] = useState(false);

  const masked = secret
    ? `${secret.slice(0, 6)}${"•".repeat(12)}${secret.slice(-4)}`
    : "";

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <p className="text-sm font-medium">Payload URL</p>
        <div className="flex min-w-0 items-center gap-2 rounded-md border px-3 py-2">
          <code className="min-w-0 flex-1 truncate font-mono text-xs select-all">
            {ingestUrl}
          </code>
          <CopyButton value={ingestUrl} />
        </div>
        <p className="text-muted-foreground text-xs">
          Paste this into your provider&apos;s webhook configuration — in
          GitHub, Settings → Webhooks → Payload URL.
          {!IS_CLOUD && (
            <>
              {" "}
              <Link
                href="/settings/instance"
                className="hover:text-foreground underline transition-colors"
              >
                Check your public URL
              </Link>{" "}
              if this host is not reachable from the internet.
            </>
          )}
        </p>
      </div>

      {secret ? (
        <div className="space-y-1.5">
          <p className="text-sm font-medium">Secret</p>
          <div className="flex min-w-0 items-center gap-2 rounded-md border px-3 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-xs select-all">
              {revealed ? secret : masked}
            </code>
            <button
              type="button"
              onClick={() => setRevealed((value) => !value)}
              className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
              aria-label={revealed ? "Hide secret" : "Reveal secret"}
            >
              {revealed ? (
                <EyeOff className="size-3.5" />
              ) : (
                <Eye className="size-3.5" />
              )}
            </button>
            <CopyButton value={secret} />
          </div>
          <p className="text-muted-foreground text-xs">
            {SECRET_LABELS[verification] ?? "Send with every request."}
          </p>
        </div>
      ) : (
        <div className="rounded-md border border-amber-500/40 px-3 py-2">
          <p className="text-xs text-amber-600 dark:text-amber-400">
            This endpoint accepts any request that reaches the URL. The URL is
            the only secret — do not paste it into an issue or a screenshot.
          </p>
        </div>
      )}

      {/* The single most common setup failure: GitHub defaults to
          form-encoded, and a sender that posts something else gets a 415. */}
      <div className="space-y-1.5">
        <p className="text-sm font-medium">Content type</p>
        <p className="text-muted-foreground text-xs">
          Choose <code className="font-mono">application/json</code>. GitHub
          defaults to <code className="font-mono">form-urlencoded</code>, which
          works too, but JSON is what every template example assumes.
        </p>
      </div>

      <TestCommand
        ingestUrl={ingestUrl}
        verification={verification}
        secret={secret}
      />
    </div>
  );
};
