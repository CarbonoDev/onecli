import { Globe } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import type { OrgDomainRow } from "@/lib/api";
import { DomainRow } from "./domain-row";

export interface DomainsListProps {
  domains: OrgDomainRow[];
}

// No error prop: the parent (domains-content) early-returns AdminOnlyNotice on
// the query's error, so this list only renders with a live feed.
export const DomainsList = ({ domains }: DomainsListProps) =>
  domains.length === 0 ? (
    // `dashed`, not `card`: this sits INSIDE the add-domain card, among its
    // other content, rather than replacing the page surface.
    // The copy deliberately does NOT promise SSO: this branch deletes that
    // page, and an empty state that names a surface the product doesn't have
    // is a promise the next click can't keep.
    <EmptyState
      variant="dashed"
      icon={Globe}
      things="domains"
      description="Add a domain to prove your organization owns it."
    />
  ) : (
    <div className="space-y-3">
      {domains.map((domain) => (
        <DomainRow key={domain.id} domain={domain} />
      ))}
    </div>
  );
