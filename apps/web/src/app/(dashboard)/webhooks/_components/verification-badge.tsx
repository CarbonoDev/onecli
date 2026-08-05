import { KeyRound, ShieldAlert, ShieldCheck } from "lucide-react";

export interface VerificationBadgeProps {
  verification: string;
}

/**
 * Follows the activity log's badge idiom — a span plus a lucide icon, not the
 * `Badge` component — so the two log-shaped surfaces read the same.
 */
export const VerificationBadge = ({ verification }: VerificationBadgeProps) => {
  if (verification === "github") {
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1 text-xs font-medium">
        <ShieldCheck className="size-3 shrink-0" />
        GitHub HMAC
      </span>
    );
  }

  if (verification === "token") {
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1 text-xs font-medium">
        <KeyRound className="size-3 shrink-0" />
        Shared token
      </span>
    );
  }

  // Worth flagging every time it is rendered: with no verification, anyone who
  // learns the URL can post to it.
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-400">
      <ShieldAlert className="size-3 shrink-0" />
      Unverified
    </span>
  );
};
