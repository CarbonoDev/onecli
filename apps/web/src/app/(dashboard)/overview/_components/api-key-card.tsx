"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Eye, EyeOff, Copy, Check } from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Button } from "@onecli/ui/components/button";
import { Skeleton } from "@onecli/ui/components/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@onecli/ui/components/alert-dialog";
import { apiKeyLastUsed } from "@onecli/api/lib/api-key-activity";
import { LoadErrorNotice } from "@/components/load-error-notice";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { queryKeys } from "@/lib/api/keys";
import { maskSecret } from "@/lib/mask-secret";
import { getApiKey, regenerateApiKey } from "@/lib/actions/api-key";

/**
 * The honest limit of the usage reading, on hover for the arms that assert an
 * absence. Only a *successful* authentication is recorded — a rejected key,
 * and an org key that never named a project, both leave nothing behind — so
 * these labels can never be read as "nobody has tried this key".
 *
 * This carries the caveat ALONE on /overview, where the card renders with no
 * page description, so it has to stand on its own. It divides the work with
 * the /settings/api-keys description: that page glosses what each absence
 * label CLAIMS ("Never used" vs "No recent activity", which differ by whether
 * the key predates tracking); this states what the recording MISSES, which is
 * the same for both arms and is why neither is evidence of an untried key.
 * Keep them complementary — do not move this sentence back into the page
 * description.
 */
const NO_USAGE_CAVEAT =
  "Only successful authentications are recorded, so this does not mean the key was never presented.";

export const ApiKeyCard = () => {
  const queryClient = useQueryClient();
  const [revealed, setRevealed] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const { copied, copy } = useCopyToClipboard();

  // A QUERY, not a mount effect. The key it shows belongs to the current
  // project, and a switch re-renders this card without remounting it — an
  // effect with an empty dep array would keep displaying the PREVIOUS
  // project's key next to a Regenerate button that acts on the current one.
  // `scope()`-prefixed, so the switch's cookie write re-keys it on its own.
  const {
    data,
    isPending: loading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: queryKeys.apiKey.current(),
    // Wrapped, never passed bare: react-query hands its queryFn a context
    // object, and a server action would try to serialize it as an argument.
    queryFn: () => getApiKey(),
  });

  // The failure has to reach a console SOMEWHERE. `getApiKey` is a server
  // action, so Next.js redacts the thrown message to a generic string plus a
  // `digest` before it crosses to the browser, and react-query then swallows
  // the rejection — which is exactly how this surface could fail with an
  // empty console. Logged once per SETTLED error rather than per attempt, so
  // the digest is on hand to correlate with the server log that still holds
  // the real reason.
  useEffect(() => {
    if (error) console.error("Failed to load the project API key", error);
  }, [error]);

  const apiKey = data?.apiKey ?? "";
  const truncatedKey = apiKey ? maskSecret(apiKey) : "";
  // Only meaningful once the key itself has loaded — there is no usage to
  // report for a project that has no key.
  const lastUsed = data
    ? apiKeyLastUsed(data.lastUsedAt, data.createdAt)
    : null;

  const handleRegenerate = async () => {
    setRegenerating(true);
    try {
      const result = await regenerateApiKey();
      // Rotation retires the old secret, so its usage history goes with it —
      // the service clears `lastUsedAt`, and mirroring that here keeps the
      // card from attributing the OLD key's activity to the new one. The row
      // keeps its original `createdAt`, so this matches what a refetch says.
      queryClient.setQueryData(queryKeys.apiKey.current(), {
        apiKey: result.apiKey,
        lastUsedAt: null,
        createdAt: data?.createdAt ?? new Date().toISOString(),
      });
      setRevealed(true);
      toast.success("API key regenerated");
    } catch {
      toast.error("Failed to regenerate API key");
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>API Key</CardTitle>
        <CardDescription>
          Your personal API key for this project.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* A failed read is NOT a slow read. Without this branch the skeleton
            pulses forever with Reveal, Copy and Regenerate all disabled — the
            same picture as "still loading", with no message, no retry and
            nothing in the console. Every other state of this card is
            recoverable by the person looking at it; this one has to be too.

            No 403 arm here, unlike `usage-content` and the domains page: those
            read through the API client, whose `ApiError.status` distinguishes
            a settled "you may not" from a transport failure. `getApiKey` is a
            SERVER ACTION — it throws plain `Error`s that Next.js redacts on
            the way out — so nothing survives the boundary to tell the two
            apart, and inventing a permissions story from an opaque rejection
            would be a guess. One honest, retryable message instead.

            The message is fixed for the same reason: the thrown text is
            replaced with a generic string in production, so rendering
            `error.message` would show the user Next.js's boilerplate. */}
        {isError ? (
          <LoadErrorNotice
            variant="dashed"
            title="Couldn't load your API key"
            message="Something went wrong reading this project's API key — the key itself is unchanged."
            onRetry={() => void refetch()}
          />
        ) : (
          <>
            <div className="flex items-center gap-2">
              {loading ? (
                <Skeleton className="h-9 flex-1 rounded-md" />
              ) : (
                <code className="bg-muted min-w-0 flex-1 truncate rounded-md border px-3 py-2 font-mono text-sm select-none">
                  {!apiKey ? (
                    <span className="text-muted-foreground">
                      No API key yet
                    </span>
                  ) : revealed ? (
                    apiKey
                  ) : (
                    truncatedKey
                  )}
                </code>
              )}
              <Button
                variant="ghost"
                size="icon"
                aria-label={revealed ? "Hide API key" : "Reveal API key"}
                onClick={() => setRevealed(!revealed)}
                disabled={loading || !apiKey}
              >
                {revealed ? (
                  <EyeOff className="size-4" />
                ) : (
                  <Eye className="size-4" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Copy API key"
                onClick={() => copy(apiKey)}
                disabled={loading || !apiKey}
              >
                {copied ? (
                  <Check className="size-4 text-brand" />
                ) : (
                  <Copy className="size-4" />
                )}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Regenerate API key"
                    disabled={loading || regenerating || !apiKey}
                  >
                    <RefreshCw
                      className={`size-4 ${regenerating ? "animate-spin" : ""}`}
                    />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Regenerate API key?</AlertDialogTitle>
                    <AlertDialogDescription>
                      The current API key will be invalidated immediately. Any
                      services using the old key will lose access.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleRegenerate}
                      disabled={regenerating}
                    >
                      {regenerating ? "Regenerating..." : "Regenerate"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>

            {/* What makes a leak detectable at all: whether this key is still
            being presented, and how recently. Same idiom as the agent card —
            one line of text with the freshness dot INSIDE it, never a second
            status chip. Skipped entirely when there is no key to describe. */}
            {!loading && apiKey && lastUsed && (
              <p
                className="text-muted-foreground mt-2 inline-flex items-center gap-1.5 text-xs"
                title={lastUsed.exactAt?.toLocaleString() ?? NO_USAGE_CAVEAT}
              >
                {lastUsed.fresh && (
                  <span
                    aria-hidden
                    className="bg-brand size-1.5 shrink-0 rounded-full"
                  />
                )}
                {lastUsed.label}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
};
