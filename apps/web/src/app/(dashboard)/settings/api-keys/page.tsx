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
        // The last sentence glosses BOTH absence labels the card can render
        // (`lastActivity` in @onecli/api/lib/last-activity), because a
        // description that explains only "Never used" is unreadable to the
        // majority of keys — those minted before API_KEY_USAGE_TRACKED_SINCE
        // — which see "No recent activity" instead.
        //
        // What is deliberately NOT here: that a rejected key leaves no trace
        // at all. That belongs on the label itself, and the card already
        // hovers it (NO_USAGE_CAVEAT). Repeating it would make this a
        // paragraph and say nothing the hover doesn't.
        description="OneCLI issues one personal API key per project. Copy it for the CLI, or regenerate it if it leaks. “Never used” means no successful authentication since usage tracking began; “No recent activity” means the key predates tracking, so earlier use is unknown."
      />
      <ApiKeyCard />
    </div>
  );
}
