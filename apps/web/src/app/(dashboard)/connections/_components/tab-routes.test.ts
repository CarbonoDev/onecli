import { describe, expect, it } from "vitest";
import {
  CONNECTIONS_TABS,
  activeTabFor,
  isConnectionsTab,
  tabRoutesFor,
} from "./tab-routes";

describe("tabRoutesFor", () => {
  it("roots the project tabs at /connections", () => {
    expect(tabRoutesFor("/connections")).toMatchObject({
      apps: "/connections",
      custom: "/connections/custom",
      connected: "/connections/connected",
    });
  });

  it("keeps a /p/<id> prefix", () => {
    expect(tabRoutesFor("/p/proj-1/connections/custom")).toMatchObject({
      apps: "/p/proj-1/connections",
      llms: "/p/proj-1/connections/llms",
    });
  });

  it("uses basePath verbatim when given", () => {
    expect(
      tabRoutesFor("/global-connections/llms", "/global-connections"),
    ).toMatchObject({
      apps: "/global-connections",
      llms: "/global-connections/llms",
    });
  });

  /**
   * The regression this file exists for. The old fallback scanned for the
   * literal substring `"/connections"`, which does NOT occur in
   * `/global-connections` — so it fell through to its `/connections` default
   * and pointed every org tab at the PROJECT page. `basePath` shields the org
   * page today, but the fallback must not be a landmine for the next caller
   * who omits it.
   */
  it("does not send /global-connections to the project section", () => {
    expect(tabRoutesFor("/global-connections")).toMatchObject({
      apps: "/global-connections",
      custom: "/global-connections/custom",
      llms: "/global-connections/llms",
      connected: "/global-connections/connected",
    });
    expect(tabRoutesFor("/global-connections/custom").custom).toBe(
      "/global-connections/custom",
    );
  });
});

describe("activeTabFor", () => {
  it("reads the tab off the path", () => {
    expect(activeTabFor("/connections")).toBe("apps");
    expect(activeTabFor("/connections/custom")).toBe("custom");
    expect(activeTabFor("/connections/llms")).toBe("llms");
    expect(activeTabFor("/connections/budgets")).toBe("budgets");
    expect(activeTabFor("/connections/vaults")).toBe("vaults");
    expect(activeTabFor("/connections/connected")).toBe("connected");
  });

  it("falls back to apps for detail routes", () => {
    expect(activeTabFor("/connections/apps/github")).toBe("apps");
    expect(activeTabFor("/connections/vaults/onepassword")).toBe("apps");
  });

  it("honours basePath", () => {
    expect(
      activeTabFor("/global-connections/llms", "/global-connections"),
    ).toBe("llms");
    expect(activeTabFor("/global-connections", "/global-connections")).toBe(
      "apps",
    );
  });

  // Same landmine on the read side: `"/global-connections/custom".split(
  // "/connections")` yields a single element, so the old parse read every org
  // URL as the `apps` tab and the tab bar never moved off Apps.
  it("reads the tab off a /global-connections path", () => {
    expect(activeTabFor("/global-connections")).toBe("apps");
    expect(activeTabFor("/global-connections/custom")).toBe("custom");
    expect(activeTabFor("/global-connections/connected")).toBe("connected");
  });

  // `basePath` is only the authority for paths actually under it. This is the
  // case that discriminates: a stale org basePath during a cross-section
  // navigation. Blind slicing would take 19 chars off a 17-char string, leave
  // `""`, and report `apps` — the tab bar would jump to Apps while the page
  // rendered LLMs. Falling back to the pathname reads it correctly.
  it("falls back to the pathname when it is not under basePath", () => {
    expect(activeTabFor("/connections/llms", "/global-connections")).toBe(
      "llms",
    );
  });

  // The boundary is a segment boundary, not `startsWith`:
  // `/global-connections-archive` string-prefixes the basePath but is a
  // different section, so it is neither sliced nor recognised — and an unknown
  // section has no tabs, so it resolves to the default rather than inventing
  // one out of the leftover text.
  it("does not treat a string-prefix of basePath as being under it", () => {
    expect(
      activeTabFor("/global-connections-archive/custom", "/global-connections"),
    ).toBe("apps");
  });
});

describe("isConnectionsTab", () => {
  // Load-bearing in `handleTabChange`: `AnimatedTabs` hands back a bare string,
  // and anything this rejects is dropped rather than routed to `undefined`.
  it("accepts every declared tab", () => {
    for (const tab of CONNECTIONS_TABS) {
      expect(isConnectionsTab(tab)).toBe(true);
    }
  });

  it("rejects anything else", () => {
    expect(isConnectionsTab("secrets")).toBe(false);
    expect(isConnectionsTab("")).toBe(false);
    expect(isConnectionsTab("Apps")).toBe(false);
    expect(isConnectionsTab("toString")).toBe(false);
  });
});
