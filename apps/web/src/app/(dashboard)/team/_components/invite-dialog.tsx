"use client";

import { useState } from "react";
import { CircleCheck } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import { useCreateInvitation } from "@/hooks/use-invitations";
import type { InvitationRow } from "@/lib/api";
import { InviteLinkField } from "./invite-link-field";

export interface InviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const InviteDialog = ({ open, onOpenChange }: InviteDialogProps) => {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [created, setCreated] = useState<InvitationRow | null>(null);
  const createInvitation = useCreateInvitation();

  const trimmedEmail = email.trim();
  const isEmailPlausible = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail);

  const handleCreate = () => {
    if (!isEmailPlausible || createInvitation.isPending) return;
    createInvitation.mutate(
      { email: trimmedEmail, role },
      { onSuccess: (invitation) => setCreated(invitation) },
    );
  };

  const handleClose = (value: boolean) => {
    if (!value) {
      setEmail("");
      setRole("member");
      setCreated(null);
    }
    onOpenChange(value);
  };

  // D-I: the link is composed from the browser's own origin — the server
  // never guesses a public URL.
  const joinLink = created
    ? `${window.location.origin}/join/${created.token}`
    : "";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        {created ? (
          <>
            <div className="flex flex-col items-center pt-2 text-center">
              <div className="bg-brand/10 mb-3 flex size-10 items-center justify-center rounded-full">
                <CircleCheck className="size-5 text-brand" />
              </div>
              <DialogHeader className="items-center">
                <DialogTitle>Invitation created</DialogTitle>
                <DialogDescription>
                  OneCLI open edition doesn&apos;t send email. Copy this link
                  and send it to <strong>{created.email}</strong> yourself. They
                  must sign in with that exact Google address, and the link
                  expires in 7 days.
                </DialogDescription>
              </DialogHeader>
            </div>
            <div className="py-2">
              <InviteLinkField link={joinLink} />
            </div>
            <DialogFooter>
              <Button onClick={() => handleClose(false)} className="w-full">
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Invite a member</DialogTitle>
              <DialogDescription>
                Create an invitation link for a teammate. They must sign in with
                the exact Google address you enter here.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div className="space-y-2">
                <Label htmlFor="invite-email">Email</Label>
                <Input
                  id="invite-email"
                  type="email"
                  placeholder="teammate@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreate();
                  }}
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="invite-role">Role</Label>
                <Select
                  value={role}
                  onValueChange={(value) =>
                    setRole(value === "admin" ? "admin" : "member")
                  }
                >
                  <SelectTrigger id="invite-role" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">Member</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => handleClose(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleCreate}
                loading={createInvitation.isPending}
                disabled={!isEmailPlausible || createInvitation.isPending}
              >
                {createInvitation.isPending
                  ? "Creating..."
                  : "Create invitation"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};
