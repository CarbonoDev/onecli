import { Suspense } from "react";
import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { PolicyEditor } from "@/lib/policy-editor";

// "Global Policy", matching the org shell's nav item and the breadcrumb. The
// name carries its own scope now that the project shell sits beside it — the
// bare "Policy" was unambiguous only while there was one flat nav.
export const metadata: Metadata = {
  title: "Global Policy",
};

/**
 * The ORGANIZATION policy surface — the guardrails every project is evaluated
 * against. The gateway evaluates these rules alongside each project's own
 * policy and takes the stricter verdict (`policy_engine/evaluate.rs`), so they
 * override nothing and can only tighten.
 *
 * A single scope: project-scope authoring retired in attach-model step 6
 * (`/v1/policy/*` is 410'd; project rules compile from agent grants), so there
 * is no scope switcher. No server-side role resolution — the API's 403 is the
 * authority on who is an admin, and `PolicyEditor` renders the degrade when the
 * org policy read fails.
 */
export default function PolicyPage() {
  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Global Policy"
        description="Organization rules apply to every project — the stricter of the organization and project levels wins."
      />
      <Suspense>
        <PolicyEditor scope="organization" />
      </Suspense>
    </div>
  );
}
