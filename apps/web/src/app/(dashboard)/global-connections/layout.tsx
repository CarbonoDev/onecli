import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Global Connections",
};

// The segment name matches `connectionsPath`'s documented org base path
// (`/org/<id>/global-connections`), so one name works across editions.
//
// Mirrors `connections/layout.tsx`: this outer layout owns only the metadata
// and the page frame, while the `(tabs)` group inside owns the header and tab
// bar. The split is what lets a future org app-detail page sit at
// `/global-connections/apps/<provider>` without inheriting the tab bar.
export default function GlobalConnectionsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="flex flex-1 flex-col gap-6">{children}</div>;
}
