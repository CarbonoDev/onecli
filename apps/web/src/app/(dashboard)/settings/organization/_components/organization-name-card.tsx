"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import type { Organization } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { useRenameOrganization } from "@/hooks/use-organizations";

export interface OrganizationNameCardProps {
  organization: Organization;
  canManage: boolean;
}

export const OrganizationNameCard = ({
  organization,
  canManage,
}: OrganizationNameCardProps) => {
  const [name, setName] = useState(organization.name);
  const rename = useRenameOrganization();
  const qc = useQueryClient();

  const trimmed = name.trim();
  const error =
    trimmed.length === 0
      ? "Name is required."
      : trimmed.length > 255
        ? "Name must be 255 characters or fewer."
        : null;
  const dirty = trimmed !== organization.name;

  const handleSave = () => {
    if (error || !dirty || rename.isPending) return;
    rename.mutate(
      { id: organization.id, name: trimmed },
      {
        onSuccess: () => {
          // The rename hook deliberately owns no cache, so the invalidation
          // lives with the component that knows which query it fed. `all()` is
          // the org switcher's UNSCOPED prefix — invalidating anything narrower
          // leaves the switcher showing the old name until a reload.
          qc.invalidateQueries({ queryKey: queryKeys.organizations.all() });
          toast.success("Organization renamed");
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Name</CardTitle>
        <CardDescription>
          How this organization appears across the dashboard. Names do not have
          to be unique.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="max-w-sm space-y-2">
          <Label htmlFor="organization-name">Organization name</Label>
          <Input
            id="organization-name"
            value={name}
            disabled={!canManage}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave();
            }}
          />
          {error && dirty && (
            <p className="text-destructive text-xs">{error}</p>
          )}
        </div>
        <Button
          onClick={handleSave}
          loading={rename.isPending}
          disabled={!canManage || !dirty || error !== null || rename.isPending}
        >
          {rename.isPending ? "Saving..." : "Save"}
        </Button>
      </CardContent>
    </Card>
  );
};
