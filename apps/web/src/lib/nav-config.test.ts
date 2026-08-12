import { describe, expect, it } from "vitest";
import {
  navBreadcrumbLabel,
  navItemsForShell,
  orgNavItems,
  projectNavItems,
  resolveNavShell,
  settingsSections,
} from "./nav-config";

/**
 * `resolveNavShell` is pure and reads no `CAPS`, so unlike `hasProjectContext`
 * it needs no `vi.stubEnv` + `vi.resetModules` dance — every case is just an
 * input string.
 */
describe("resolveNavShell", () => {
  it("puts the project nav items in the project shell", () => {
    expect(resolveNavShell("/overview")).toBe("project");
    expect(resolveNavShell("/install")).toBe("project");
    expect(resolveNavShell("/agents")).toBe("project");
    expect(resolveNavShell("/connections")).toBe("project");
    expect(resolveNavShell("/activity")).toBe("project");
  });

  it("puts the org nav items in the org shell", () => {
    expect(resolveNavShell("/projects")).toBe("org");
    expect(resolveNavShell("/policy")).toBe("org");
    expect(resolveNavShell("/team")).toBe("org");
    expect(resolveNavShell("/groups")).toBe("org");
    expect(resolveNavShell("/usage")).toBe("org");
  });

  it("keeps detail routes in their parent's shell", () => {
    expect(
      resolveNavShell("/agents/8f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f"),
    ).toBe("project");
    expect(resolveNavShell("/connections/apps/github")).toBe("project");
    expect(resolveNavShell("/connections/vaults")).toBe("project");
  });

  it("does not collide /global-connections with /connections", () => {
    expect(resolveNavShell("/global-connections")).toBe("org");
    expect(resolveNavShell("/global-connections/apps")).toBe("org");
  });

  it("matches on segment boundaries, not bare prefixes", () => {
    // `/policy-drafts` starts with `/policy` but is not under it.
    expect(resolveNavShell("/policy-drafts")).toBe("org");
    expect(resolveNavShell("/agents-archive")).toBe("org");
  });

  it("splits /settings by the longest matching nav url", () => {
    expect(resolveNavShell("/settings/project")).toBe("project");
    expect(resolveNavShell("/settings/organization")).toBe("org");
  });

  it("defaults settings pages owned by neither shell to org", () => {
    expect(resolveNavShell("/settings")).toBe("org");
    expect(resolveNavShell("/settings/profile")).toBe("org");
    expect(resolveNavShell("/settings/api-keys")).toBe("org");
    expect(resolveNavShell("/settings/instance")).toBe("org");
    expect(resolveNavShell("/settings/encryption")).toBe("org");
    expect(resolveNavShell("/settings/domains")).toBe("org");
    expect(resolveNavShell("/settings/sso")).toBe("org");
  });

  it("defaults unknown paths to org", () => {
    expect(resolveNavShell("/account/organizations")).toBe("org");
    expect(resolveNavShell("/nope")).toBe("org");
    expect(resolveNavShell("/")).toBe("org");
  });
});

describe("navItemsForShell", () => {
  it("flattens the org groups and returns the project list as-is", () => {
    expect(navItemsForShell("org")).toEqual(orgNavItems.flat());
    expect(navItemsForShell("project")).toEqual(projectNavItems);
  });

  it("every item's own url resolves back to its shell", () => {
    for (const item of navItemsForShell("org")) {
      expect(resolveNavShell(item.url)).toBe("org");
    }
    for (const item of navItemsForShell("project")) {
      expect(resolveNavShell(item.url)).toBe("project");
    }
  });
});

describe("navBreadcrumbLabel", () => {
  it("fixes the settings casing the raw slug got wrong", () => {
    // The defect this exists for: the breadcrumb read "Api keys" while the
    // page heading read "API Keys".
    expect(navBreadcrumbLabel("/settings/api-keys")).toBe("API Keys");
    expect(navBreadcrumbLabel("/settings/sso")).toBe("Single sign-on");
  });

  it("overrides the Projects nav label with the crumb label", () => {
    expect(navBreadcrumbLabel("/projects")).toBe("All projects");
  });

  it("returns nav titles for nav urls", () => {
    expect(navBreadcrumbLabel("/global-connections")).toBe(
      "Global Connections",
    );
    expect(navBreadcrumbLabel("/team")).toBe("Members");
    expect(navBreadcrumbLabel("/settings/encryption")).toBe("Encryption");
  });

  it("prefers the settings sub-nav title where both name the same url", () => {
    // The sidebar calls these "Project Settings" / "Organization Settings"
    // because it has no other context; as the leaf of `Settings › …` the
    // settings sub-nav's shorter titles are the ones that read correctly.
    expect(navBreadcrumbLabel("/settings/project")).toBe("Project");
    expect(navBreadcrumbLabel("/settings/organization")).toBe("Organization");
  });

  it("is undefined for paths nothing owns", () => {
    expect(navBreadcrumbLabel("/agents/ag-1")).toBeUndefined();
    expect(navBreadcrumbLabel("/connections/apps")).toBeUndefined();
  });
});

describe("settingsSections", () => {
  // `settings/page.tsx` redirects `/settings` to the first item of the first
  // section; keeping Project there keeps that redirect working with no edit.
  it("keeps Project as the first entry", () => {
    expect(settingsSections[0]?.items[0]?.url).toBe("/settings/project");
  });

  it("appends Domains and Single sign-on to Security", () => {
    const security = settingsSections.find((s) => s.label === "Security");
    expect(security?.items.map((i) => i.title)).toEqual([
      "Domains",
      "Single sign-on",
      "Encryption",
    ]);
  });
});
