"use client";

import { useState } from "react";
import { Copy, Check, Eye, EyeOff } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { maskSecret } from "@/lib/mask-secret";

interface TryDemoCommandProps {
  command: string;
  highlight?: string;
  /** A secret occurring inside `command` (an API key). When set, the rendered
   * command masks every occurrence until the user reveals it, and a reveal
   * toggle appears. The copy button always copies the real `command`, so a
   * masked block still pastes as a working command. Never pass an empty
   * string — `replaceAll("")` inserts between every character. Not used
   * together with `highlight`. */
  secret?: string;
}

export const TryDemoCommand = ({
  command,
  highlight,
  secret,
}: TryDemoCommandProps) => {
  const { copied, copy } = useCopyToClipboard();
  const [revealed, setRevealed] = useState(false);

  const masked = !!secret && !revealed;
  const shownCommand =
    masked && secret ? command.replaceAll(secret, maskSecret(secret)) : command;

  const renderCommand = () => {
    if (!highlight) return shownCommand;
    const idx = shownCommand.indexOf(highlight);
    if (idx === -1) return shownCommand;
    return (
      <>
        {shownCommand.slice(0, idx)}
        <span className="text-brand font-semibold">{highlight}</span>
        {shownCommand.slice(idx + highlight.length)}
      </>
    );
  };

  return (
    <div className="relative">
      <pre
        className={cn(
          "bg-muted rounded-md border p-3 font-mono text-xs whitespace-pre-wrap break-all",
          // Two size-9 buttons instead of one when the reveal toggle is shown.
          secret ? "pr-21" : "pr-10",
          // Without this a drag-select over the bullets pastes a broken
          // command that fails with an unhelpful auth error.
          masked && "select-none",
        )}
      >
        {renderCommand()}
      </pre>
      {masked && (
        <span className="sr-only">
          API key hidden — use the copy button to copy the working command.
        </span>
      )}
      <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5">
        {secret && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={revealed ? "Hide API key" : "Show API key"}
            onClick={() => setRevealed(!revealed)}
          >
            {revealed ? (
              <EyeOff className="size-4" />
            ) : (
              <Eye className="size-4" />
            )}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Copy command"
          onClick={() => copy(command)}
        >
          {copied ? (
            <Check className="size-4 text-brand" />
          ) : (
            <Copy className="size-4" />
          )}
        </Button>
      </div>
    </div>
  );
};
