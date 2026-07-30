import { Folder } from "lucide-react";
import type { GranularAccessConfig } from "../types";

export const dropboxConfig: GranularAccessConfig = {
  // Folders are browsed live in the policy dialog (Dropbox has no
  // connect-time folder list), so granular access is always available for a
  // connected Dropbox account.
  isSupported: () => true,
  // Items come from the live folder browser, not connection metadata.
  getItems: () => [],
  buildPolicy: (folders) => (folders.length > 0 ? { folders } : {}),
  getSelectedItems: (policy) => (policy.folders as string[]) ?? [],
  itemLabel: { singular: "folder", plural: "folders" },
  // The gateway's `folder_in_scope` requires a leading-slash, `/`-delimited
  // Dropbox path. A bare name never matches (fail-closed brick); the root `/`
  // normalizes to "" and silently allows everything (a no-op restriction).
  validateEntry: (value) => {
    if (!value.startsWith("/")) {
      return "Folder must be an absolute path starting with /";
    }
    if (value.replace(/\/+$/, "") === "") {
      return "Use no restriction instead of / (the root allows everything)";
    }
    // Dot-segments never collapse on the allow side (they're literal
    // segment-prefixes), while request paths carrying `.`/`..` are rejected as
    // Unparseable — so such an entry silently matches nothing (a fail-closed
    // brick). Reject it up front.
    if (value.split("/").some((s) => s === "." || s === "..")) {
      return "Folder path can't contain . or .. segments";
    }
    return null;
  },
  Icon: Folder,
  formatSummary: (policy) => {
    const folders = (policy?.folders as string[] | undefined) ?? [];
    return folders.length > 0
      ? `${folders.length} ${folders.length === 1 ? "folder" : "folders"}`
      : "All folders";
  },
};
