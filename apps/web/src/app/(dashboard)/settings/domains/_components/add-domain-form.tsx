"use client";

import { useId, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { useClaimDomain } from "@/hooks/use-domains";

/**
 * The claim form. No lock icon on the button and no gate behind it — this
 * edition has no plan tiers, so every organization can claim every domain it
 * can prove it owns.
 */
export const AddDomainForm = () => {
  const inputId = useId();
  const [value, setValue] = useState("");
  const claim = useClaimDomain();

  const trimmed = value.trim();

  const submit = () => {
    if (!trimmed || claim.isPending) return;
    // The raw string goes over the wire as typed: the server owns
    // normalization, because it owns the value the global unique index sees.
    claim.mutate(trimmed, { onSuccess: () => setValue("") });
  };

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Label htmlFor={inputId}>Add a domain</Label>
      <div className="flex items-center gap-2">
        <Input
          id={inputId}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="example.com"
          autoComplete="off"
          spellCheck={false}
          className="max-w-xs"
          disabled={claim.isPending}
        />
        <Button type="submit" disabled={!trimmed || claim.isPending}>
          {claim.isPending ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Adding...
            </>
          ) : (
            "Add domain"
          )}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        You&apos;ll prove ownership by publishing a DNS TXT record.
      </p>
    </form>
  );
};
