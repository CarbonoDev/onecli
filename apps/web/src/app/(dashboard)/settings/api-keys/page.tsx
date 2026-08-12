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
        description="OneCLI issues one personal API key per project. Copy it for the CLI, or regenerate it if it leaks."
      />
      <ApiKeyCard />
    </div>
  );
}
