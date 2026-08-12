import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/lib/api/types";

/**
 * `useNavShell` calls two hooks and branches on their values — it holds no
 * state and runs no effects, so mocking both lets it be called directly with
 * no renderer. `vi.hoisted` because `vi.mock` factories are lifted above the
 * imports.
 */
const mocks = vi.hoisted(() => ({
  usePathname: vi.fn<() => string>(),
  useProjectsList: vi.fn<() => { data?: Project[]; isError?: boolean }>(),
}));

vi.mock("next/navigation", () => ({ usePathname: mocks.usePathname }));
vi.mock("./use-projects", () => ({ useProjectsList: mocks.useProjectsList }));

const { useNavShell } = await import("./use-nav-shell");

const project = { id: "p1", name: "Test" } as Project;

beforeEach(() => {
  mocks.usePathname.mockReset();
  mocks.useProjectsList.mockReset();
});

/** Named `use…` so `react-hooks/rules-of-hooks` accepts the call — the hook
 * itself is stateless, so calling it outside a render is safe. */
const useShellAt = (pathname: string) => {
  mocks.usePathname.mockReturnValue(pathname);
  return useNavShell();
};

describe("useNavShell", () => {
  it("defers to the route table while the list is still loading", () => {
    // The regression this guards: `!projects?.length` is true for BOTH
    // `undefined` and `[]`, so "simplifying" the check would flip every
    // project page into the org shell for one frame on every single load.
    mocks.useProjectsList.mockReturnValue({ data: undefined });
    expect(useShellAt("/overview")).toBe("project");
    expect(useShellAt("/agents")).toBe("project");
    expect(useShellAt("/team")).toBe("org");
  });

  it("defers to the route table once projects exist", () => {
    mocks.useProjectsList.mockReturnValue({ data: [project] });
    expect(useShellAt("/overview")).toBe("project");
    expect(useShellAt("/settings/project")).toBe("project");
    expect(useShellAt("/projects")).toBe("org");
  });

  it("forces the org shell when the caller has no projects", () => {
    // An admin who deleted their last project still gets sent to /overview.
    // The project shell would offer a back link, project nav, and a switcher
    // that renders nothing — the org shell is where they can create one.
    mocks.useProjectsList.mockReturnValue({ data: [] });
    expect(useShellAt("/overview")).toBe("org");
    expect(useShellAt("/agents")).toBe("org");
    expect(useShellAt("/settings/project")).toBe("org");
  });

  it("does not treat a failed list as emptiness", () => {
    // An error proves nothing about how many projects exist; swapping the
    // shell out from under the user on a transient failure is worse than
    // leaving the route table in charge.
    mocks.useProjectsList.mockReturnValue({ data: undefined, isError: true });
    expect(useShellAt("/overview")).toBe("project");
  });
});
