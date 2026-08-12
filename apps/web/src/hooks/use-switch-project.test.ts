import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/api/keys";

/**
 * Same shape as the `useNavShell` test: the hook holds no state and runs no
 * effects, so mocking its four collaborators lets it be called directly with
 * no renderer. `vi.hoisted` because `vi.mock` factories are lifted above the
 * imports.
 */
const mocks = vi.hoisted(() => ({
  push: vi.fn<(href: string) => void>(),
  refresh: vi.fn<() => void>(),
  clear: vi.fn<() => void>(),
  setQueryData: vi.fn<(key: unknown, value: unknown) => void>(),
  writeDefaultProjectCookie: vi.fn<(projectId: string) => void>(),
  useNavShell: vi.fn<() => "org" | "project">(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    clear: mocks.clear,
    setQueryData: mocks.setQueryData,
  }),
}));
vi.mock("@/lib/navigation", () => ({
  writeDefaultProjectCookie: mocks.writeDefaultProjectCookie,
}));
vi.mock("./use-nav-shell", () => ({ useNavShell: mocks.useNavShell }));

const { useSwitchProject } = await import("./use-switch-project");

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
});

describe("useSwitchProject", () => {
  it("enters the project when switching from the org shell", () => {
    // The regression: the org shell lists no project-scope pages, so a switch
    // that only refreshed left the user on /projects with no way in.
    mocks.useNavShell.mockReturnValue("org");
    useSwitchProject()("p2");

    expect(mocks.push).toHaveBeenCalledWith("/overview");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("stays put when switching from inside the project shell", () => {
    // Someone on /agents wants the new project's agents, not Overview.
    mocks.useNavShell.mockReturnValue("project");
    useSwitchProject()("p2");

    expect(mocks.refresh).toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("writes the cookie, drops the cache, then re-seeds the selection", () => {
    // Order matters: the seed has to survive the clear, or every
    // `useCurrentProjectId` subscriber holds the old id until a remount.
    const order: string[] = [];
    mocks.writeDefaultProjectCookie.mockImplementation(() =>
      order.push("cookie"),
    );
    mocks.clear.mockImplementation(() => order.push("clear"));
    mocks.setQueryData.mockImplementation(() => order.push("seed"));
    mocks.useNavShell.mockReturnValue("project");

    useSwitchProject()("p2");

    expect(order).toEqual(["cookie", "clear", "seed"]);
    expect(mocks.writeDefaultProjectCookie).toHaveBeenCalledWith("p2");
    expect(mocks.setQueryData).toHaveBeenCalledWith(
      queryKeys.scope.projectCookie(),
      "p2",
    );
  });

  it("runs that same sequence on the entering branch", () => {
    // Navigating instead of refreshing must not skip any of it — the sidebar
    // label and the /projects Current badge read the seeded value.
    mocks.useNavShell.mockReturnValue("org");
    useSwitchProject()("p3");

    expect(mocks.writeDefaultProjectCookie).toHaveBeenCalledWith("p3");
    expect(mocks.clear).toHaveBeenCalled();
    expect(mocks.setQueryData).toHaveBeenCalledWith(
      queryKeys.scope.projectCookie(),
      "p3",
    );
  });
});
