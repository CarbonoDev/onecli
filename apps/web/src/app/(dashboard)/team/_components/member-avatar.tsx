import { Avatar, AvatarFallback } from "@onecli/ui/components/avatar";

export interface MemberAvatarProps {
  /** Display name when there is one — an invitee has none until they join. */
  name?: string | null;
  email: string;
}

/**
 * Initials for the row avatar: up to two from a display name, else the first
 * letter of the email (the invited-row case, where no name exists yet).
 */
const initialsFor = (name: string | null | undefined, email: string) => {
  const trimmed = name?.trim();
  if (trimmed) {
    return trimmed
      .split(/\s+/)
      .map((word) => word[0] ?? "")
      .join("")
      .toUpperCase()
      .slice(0, 2);
  }
  return email.slice(0, 1).toUpperCase();
};

export const MemberAvatar = ({ name, email }: MemberAvatarProps) => (
  <Avatar className="size-7">
    <AvatarFallback className="text-[11px]">
      {initialsFor(name, email)}
    </AvatarFallback>
  </Avatar>
);
