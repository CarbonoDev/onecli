"use client";

import { useState } from "react";
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
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { queryKeys } from "@/lib/api/keys";
import { maskSecret } from "@/lib/mask-secret";
import { getApiKey, regenerateApiKey } from "@/lib/actions/api-key";

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
  const { data: apiKey = "", isPending: loading } = useQuery({
    queryKey: queryKeys.apiKey.current(),
    queryFn: () => getApiKey().then((result) => result.apiKey ?? ""),
  });

  const truncatedKey = apiKey ? maskSecret(apiKey) : "";

  const handleRegenerate = async () => {
    setRegenerating(true);
    try {
      const result = await regenerateApiKey();
      queryClient.setQueryData(queryKeys.apiKey.current(), result.apiKey);
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
        <div className="flex items-center gap-2">
          {loading ? (
            <Skeleton className="h-9 flex-1 rounded-md" />
          ) : (
            <code className="bg-muted min-w-0 flex-1 truncate rounded-md border px-3 py-2 font-mono text-sm select-none">
              {!apiKey ? (
                <span className="text-muted-foreground">No API key yet</span>
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
      </CardContent>
    </Card>
  );
};
