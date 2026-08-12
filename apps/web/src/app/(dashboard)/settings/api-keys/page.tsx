import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { ApiKeyCard } from "@/app/(dashboard)/overview/_components/api-key-card";

export const metadata: Metadata = {
  title: "API Keys",
};

export default function ApiKeysPage() {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader
        title="API Keys"
        // One key per (user, project) is the product: `ensureApiKey` mints
        // exactly one and Regenerate rotates it in place. "Manage your API
        // keys" promised a list that does not exist.
        //
        // The last sentence is the honest limit of the usage reading, stated
        // where an operator investigating a leak will actually see it: only
        // successful authentications are recorded, so "Never used" is not
        // evidence that nobody has tried the key.
        description="OneCLI issues one personal API key per project. Copy it for the CLI, or regenerate it if it leaks. Usage records successful authentications only — a key that was presented and rejected leaves no trace, so “Never used” does not mean “never presented”."
      />
      <ApiKeyCard />
    </div>
  );
}
