import { PageHeader } from "@dashboard/page-header";
import { ConnectionsTabs } from "../../connections/_components/connections-tabs";

/**
 * The organization connections shell.
 *
 * `pageScope` and `basePath` are passed LITERALLY, the way `/policy/page.tsx`
 * passes `scope="organization"` — not derived from a context or parsed back out
 * of the pathname. The route knows its own scope; anything that re-derives it
 * can disagree with the route that mounted it.
 *
 * The tab set is Apps | Custom | LLMs, plus a right-aligned Connected. No
 * Budgets (spend budgets are per-project), no External Vaults (a vault pairing
 * is a project connection), and no Connected count — that count would cost two
 * admin-gated reads on every page load for a member who can read neither.
 */
export default function GlobalConnectionsTabsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <PageHeader
        title="Global Connections"
        description="Organization-wide app integrations, custom secrets, and LLM keys shared across all projects."
      />
      <div className="space-y-6">
        <ConnectionsTabs
          pageScope="organization"
          basePath="/global-connections"
          showBudgets={false}
          showVaults={false}
          showConnectedCount={false}
        />
        {children}
      </div>
    </>
  );
}
