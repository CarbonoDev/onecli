"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { useAuth } from "@/providers/auth-provider";

/**
 * next-auth's `signIn()` defaults redirectTo to the current URL, so the
 * OAuth round-trip lands back on this /join/<token> page — no state to carry.
 */
export const SignInToJoinButton = () => {
  const { signIn } = useAuth();
  const [loading, setLoading] = useState(false);

  const handleSignIn = async () => {
    setLoading(true);
    try {
      await signIn();
    } catch {
      toast.error("Sign-in failed. Please try again.");
      setLoading(false);
    }
  };

  return (
    <Button className="w-full" onClick={handleSignIn} disabled={loading}>
      {loading ? (
        <>
          <Loader2 className="size-4 animate-spin" />
          Redirecting...
        </>
      ) : (
        "Sign in with Google to join"
      )}
    </Button>
  );
};
