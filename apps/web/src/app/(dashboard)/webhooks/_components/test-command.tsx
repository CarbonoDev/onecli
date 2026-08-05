"use client";

import { Check, Copy } from "lucide-react";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

export interface TestCommandProps {
  ingestUrl: string;
  verification: string;
  secret: string | null;
}

/**
 * A copyable curl rather than an in-app "send test" button.
 *
 * Deliberate: a server-side self-POST to our own public URL is an SSRF-shaped
 * surface, and a client-side one would need CORS plus an HMAC signing oracle in
 * the dashboard. More importantly, this tests the thing that actually breaks —
 * whether the provider's network can reach this origin at all — which an
 * internal test-send would bypass while showing a reassuring green.
 */
const buildCommand = (
  ingestUrl: string,
  verification: string,
  secret: string | null,
): string => {
  if (verification === "github") {
    return [
      `BODY='{"action":"opened","repository":{"full_name":"acme/api"}}'`,
      `SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac '${secret ?? "<secret>"}' -r | cut -d' ' -f1)`,
      `curl -sS -X POST '${ingestUrl}' \\`,
      `  -H "X-Hub-Signature-256: sha256=$SIG" \\`,
      `  -H 'X-GitHub-Event: issues' \\`,
      `  -H 'X-GitHub-Delivery: test-1' \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  --data-binary "$BODY"`,
    ].join("\n");
  }

  const auth =
    verification === "token"
      ? `  -H 'X-Webhook-Token: ${secret ?? "<secret>"}' \\\n`
      : "";
  return (
    `curl -sS -X POST '${ingestUrl}' \\\n` +
    auth +
    `  -H 'Content-Type: application/json' \\\n` +
    `  --data-binary '{"hello":"world"}'`
  );
};

export const TestCommand = ({
  ingestUrl,
  verification,
  secret,
}: TestCommandProps) => {
  const { copied, copy } = useCopyToClipboard();
  const command = buildCommand(ingestUrl, verification, secret);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Test it</p>
        <button
          type="button"
          onClick={() => copy(command)}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
        >
          {copied ? (
            <Check className="text-brand size-3.5" />
          ) : (
            <Copy className="size-3.5" />
          )}
          Copy
        </button>
      </div>
      <pre className="bg-muted max-h-48 overflow-auto rounded-md p-3 font-mono text-xs">
        {command}
      </pre>
      {verification === "github" && (
        <p className="text-muted-foreground text-xs">
          Note the <code className="font-mono">printf</code> and{" "}
          <code className="font-mono">--data-binary</code>: the signature covers
          the exact bytes, so a trailing newline from{" "}
          <code className="font-mono">echo</code> breaks it.
        </p>
      )}
    </div>
  );
};
