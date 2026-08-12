import { Blocks } from "lucide-react";
import { EmptyState } from "@/components/empty-state";

/**
 * The Apps tab at organization scope — deliberately NOT the app grid.
 *
 * `/v1/org/apps/*` carries the OAuth client config and host blocklists, but the
 * connect flows are not org-scoped yet: `GET /v1/apps/:provider/authorize` and
 * `POST /v1/apps/:provider/connect` still hard-400 an org-scope connect. A grid
 * here would be a page of buttons that every one of which errors, so it says
 * what is true instead and points at the surface that works.
 */
export default function GlobalConnectionsAppsPage() {
  return (
    <EmptyState
      variant="card"
      icon={Blocks}
      title="Organization app connections aren't available yet"
      description="Connect apps from a project's Connections page. Custom secrets and LLM keys added here are already shared with every project."
    />
  );
}
