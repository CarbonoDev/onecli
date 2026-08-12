"use client";

import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";

/**
 * The disclosure that keeps the Requests card honest.
 *
 * `request_logs` is not a record of all gateway traffic: the gateway writes a
 * row only when it injected a credential or made a non-plain-allow policy
 * decision (`apps/gateway/src/telemetry.rs`). A pass-through on an agent's own
 * key is never recorded, so the number below the title is a floor, not a total.
 * The card says "recorded gateway requests" and this explains the gap — it is
 * not optional polish, it is what stops the card from overstating what it knows.
 */
export const RecordedRequestsInfo = () => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button
        type="button"
        aria-label="What counts as a recorded request?"
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-full focus-visible:ring-2 focus-visible:outline-none"
      >
        <Info className="size-3.5" />
      </button>
    </TooltipTrigger>
    <TooltipContent className="max-w-xs">
      The gateway records a request when it injects a credential or makes a
      policy decision. Pass-through requests on an agent&apos;s own key are not
      recorded.
    </TooltipContent>
  </Tooltip>
);
