import { redirect } from "next/navigation";

// Not a missing tab — `/connections` IS the Apps tab (the `(tabs)` index, which
// is what `getTabRoutes` maps `apps` to). This segment exists only as the
// parent of the app detail routes (`apps/[provider]`), so the sole way to land
// here is by truncating a detail URL; the redirect turns that into the page the
// user meant. Deleting it would return a 404 instead. Deliberately `redirect()`
// (307) and not `permanentRedirect()` — a 308 caches hard and is painful to
// unwind if this segment ever grows an index of its own.
export default function AppsRedirectPage() {
  redirect("/connections");
}
