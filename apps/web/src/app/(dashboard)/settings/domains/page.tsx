import type { Metadata } from "next";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { PageHeader } from "@dashboard/page-header";

export const metadata: Metadata = {
  title: "Domains",
};

export default function DomainsPage() {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader
        title="Domains"
        description="Claim your company's email domains and verify them via DNS — the foundation for single sign-on."
      />
      <Card>
        <CardHeader>
          <CardTitle>Not available yet</CardTitle>
          <CardDescription>
            Domain claiming and DNS verification are on the way. Until then,
            invite members by email address from the Members page.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
