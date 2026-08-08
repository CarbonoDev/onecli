"use client";

import { useMemo, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@onecli/ui/components/dialog";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import type { Budget, Secret } from "@/lib/api";
import { useCreateBudget, useMeteredSecrets } from "@/hooks/use-budgets";

export interface CreateBudgetDialogProps {
  /** Existing budgets — a secret already capped is excluded from the picker. */
  existing: Budget[];
}

const dollarsToCents = (value: string): number | null => {
  const dollars = Number(value);
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  const cents = Math.round(dollars * 100);
  return cents > 0 ? cents : null;
};

export const CreateBudgetDialog = ({ existing }: CreateBudgetDialogProps) => {
  const [open, setOpen] = useState(false);
  const [secretId, setSecretId] = useState("");
  const [amount, setAmount] = useState("");
  const [period, setPeriod] = useState<"monthly" | "total">("monthly");

  const { data: secrets = [], isLoading: secretsLoading } =
    useMeteredSecrets(open);
  const create = useCreateBudget();

  const cappedIds = useMemo(
    () => new Set(existing.map((b) => b.secretId)),
    [existing],
  );
  const available = useMemo<Secret[]>(
    () => secrets.filter((s) => !cappedIds.has(s.id)),
    [secrets, cappedIds],
  );

  const cents = dollarsToCents(amount);
  const canSubmit = secretId !== "" && cents !== null && !create.isPending;

  const reset = () => {
    setSecretId("");
    setAmount("");
    setPeriod("monthly");
  };

  const onSubmit = () => {
    if (!canSubmit || cents === null) return;
    create.mutate(
      { secretId, limitCents: cents, period },
      {
        onSuccess: () => {
          setOpen(false);
          reset();
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" />
          New budget
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New spend budget</DialogTitle>
          <DialogDescription>
            Cap spend on an Anthropic or OpenAI secret. The gateway blocks new
            requests once the cap is reached — one in-flight request may
            overshoot. Streaming spend may under-count for some providers.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="budget-secret">Secret</Label>
            <Select value={secretId} onValueChange={setSecretId}>
              <SelectTrigger id="budget-secret">
                <SelectValue placeholder="Select an LLM secret" />
              </SelectTrigger>
              <SelectContent>
                {secretsLoading ? (
                  <SelectItem value="__loading" disabled>
                    Loading secrets…
                  </SelectItem>
                ) : available.length === 0 ? (
                  <SelectItem value="__none" disabled>
                    No un-capped LLM secrets
                  </SelectItem>
                ) : (
                  available.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name} ({s.type})
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="budget-amount">Cap (USD)</Label>
            <Input
              id="budget-amount"
              type="number"
              min="0.01"
              step="0.01"
              placeholder="50.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="budget-period">Period</Label>
            <Select
              value={period}
              onValueChange={(v) => setPeriod(v as "monthly" | "total")}
            >
              <SelectTrigger id="budget-period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="monthly">
                  Monthly (resets each month)
                </SelectItem>
                <SelectItem value="total">Total (lifetime cap)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={create.isPending}
          >
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={!canSubmit}>
            {create.isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Creating…
              </>
            ) : (
              "Create budget"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
