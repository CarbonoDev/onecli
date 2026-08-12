import type { Metadata } from "next";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { PageHeader } from "@dashboard/page-header";

export const metadata: Metadata = {
  title: "Single sign-on",
};

export default function SsoPage() {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader
        title="Single sign-on"
        description="Connect your identity provider so your team signs in with their company accounts."
      />
      <Card>
        <CardHeader>
          <CardTitle>Not available yet</CardTitle>
          <CardDescription>
            SAML and OIDC connections are on the way. Until then, members sign
            in with the methods this instance already allows.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
