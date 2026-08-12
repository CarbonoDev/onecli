import { describe, expect, it } from "vitest";

import {
  CODING_TOOLS,
  buildCliInstallCommand,
  buildManualInstallCommand,
  buildRunCommand,
} from "./install-command";
import { maskSecret } from "./mask-secret";

const PROD = {
  apiUrl: "https://api.onecli.sh",
  appUrl: "https://app.onecli.sh",
  apiKey: "oc_key",
};

const DEV = {
  apiUrl: "https://api.dev.onecli.sh",
  appUrl: "https://app.dev.onecli.sh",
  apiKey: "oc_key",
};

describe("buildCliInstallCommand", () => {
  it("prod, tool only — no url, no agent", () => {
    expect(buildCliInstallCommand(PROD, { tool: "claude-code" })).toBe(
      'curl -fsSL "https://api.onecli.sh/v1/install/cli?key=oc_key&tool=claude-code" | sh',
    );
  });

  it("non-prod dashboards carry the url param", () => {
    expect(buildCliInstallCommand(DEV, { tool: "codex" })).toBe(
      'curl -fsSL "https://api.dev.onecli.sh/v1/install/cli?key=oc_key&url=https%3A%2F%2Fapi.dev.onecli.sh&tool=codex" | sh',
    );
  });

  it("a chosen agent rides as agent=<identifier>", () => {
    expect(
      buildCliInstallCommand(PROD, {
        tool: "cursor",
        agentIdentifier: "writer-bot",
      }),
    ).toBe(
      'curl -fsSL "https://api.onecli.sh/v1/install/cli?key=oc_key&tool=cursor&agent=writer-bot" | sh',
    );
  });

  it("default agent = no agent param at all (the omission law)", () => {
    expect(buildCliInstallCommand(PROD, { tool: "claude-code" })).not.toContain(
      "agent=",
    );
  });

  it("no tool (the Other pill) omits tool=", () => {
    expect(
      buildCliInstallCommand(PROD, { agentIdentifier: "writer-bot" }),
    ).toBe(
      'curl -fsSL "https://api.onecli.sh/v1/install/cli?key=oc_key&agent=writer-bot" | sh',
    );
  });
});

describe("buildManualInstallCommand", () => {
  it("no context yet — placeholder key, no api-host line", () => {
    expect(buildManualInstallCommand()).toBe(
      [
        "curl -fsSL onecli.sh/cli/install | sh",
        "onecli auth login --api-key oc_...",
      ].join("\n"),
    );
  });

  it("with context — pins the api host and signs in with the real key", () => {
    expect(buildManualInstallCommand(DEV)).toBe(
      [
        "curl -fsSL onecli.sh/cli/install | sh",
        "onecli config set api-host https://api.dev.onecli.sh",
        "onecli auth login --api-key oc_key",
      ].join("\n"),
    );
  });

  it("a pinned agent adds the config line", () => {
    expect(
      buildManualInstallCommand(DEV, { agentIdentifier: "writer-bot" }),
    ).toBe(
      [
        "curl -fsSL onecli.sh/cli/install | sh",
        "onecli config set api-host https://api.dev.onecli.sh",
        "onecli auth login --api-key oc_key",
        "onecli config set agent writer-bot",
      ].join("\n"),
    );
  });
});

// D1: step 2 renders a masked twin of whichever command it shows. Neither
// builder may leak the raw key once handed a masked one — the display path
// must never be able to put a full key on screen.
describe("masked-key output leaks nothing", () => {
  const REAL_KEY = `oc_${"abcdef01".repeat(8)}`;
  const RAW_KEY_PATTERN = /oc_[0-9a-f]{64}/;
  const maskedCtx = { ...PROD, apiKey: maskSecret(REAL_KEY) };

  it("the real-key command does contain a raw key (the thing we mask)", () => {
    expect(buildCliInstallCommand({ ...PROD, apiKey: REAL_KEY })).toMatch(
      RAW_KEY_PATTERN,
    );
    expect(buildManualInstallCommand({ ...PROD, apiKey: REAL_KEY })).toMatch(
      RAW_KEY_PATTERN,
    );
  });

  it("buildCliInstallCommand emits no raw key when masked", () => {
    const masked = buildCliInstallCommand(maskedCtx, { tool: "claude-code" });
    expect(masked).not.toMatch(RAW_KEY_PATTERN);
    expect(masked).not.toContain(REAL_KEY);
    expect(masked).toContain("•");
  });

  it("buildManualInstallCommand emits no raw key when masked", () => {
    const masked = buildManualInstallCommand(maskedCtx, {
      agentIdentifier: "writer-bot",
    });
    expect(masked).not.toMatch(RAW_KEY_PATTERN);
    expect(masked).not.toContain(REAL_KEY);
    expect(masked).toContain("•");
  });

  it("masking only replaces the key — the command shape is byte-identical", () => {
    const real = buildCliInstallCommand(
      { ...PROD, apiKey: REAL_KEY },
      { tool: "claude-code" },
    );
    const masked = buildCliInstallCommand(maskedCtx, { tool: "claude-code" });
    expect(real.replaceAll(REAL_KEY, maskSecret(REAL_KEY))).toBe(masked);
  });
});

describe("CODING_TOOLS", () => {
  it("mirrors the CLI's supportedAgents table — nothing made up", () => {
    // cmd/onecli/run.go supportedAgents: the tools with dedicated `onecli run`
    // integration. github-copilot is deliberately absent (legacy-only at the
    // endpoint).
    expect(CODING_TOOLS.map((t) => t.id)).toEqual([
      "claude-code",
      "cursor",
      "codex",
      "hermes",
      "opencode",
      "openclaw",
    ]);
  });

  it("supports multi-word run commands (OpenClaw's daemon)", () => {
    expect(buildRunCommand("openclaw gateway run")).toBe(
      "onecli run -- openclaw gateway run",
    );
    expect(buildRunCommand("openclaw gateway run", "openclaw-bot")).toBe(
      "onecli run --agent openclaw-bot -- openclaw gateway run",
    );
  });
});

describe("buildRunCommand", () => {
  it("plain run for the pinned/default agent", () => {
    expect(buildRunCommand("claude")).toBe("onecli run -- claude");
  });

  it("per-run override names the agent", () => {
    expect(buildRunCommand("claude", "writer-bot")).toBe(
      "onecli run --agent writer-bot -- claude",
    );
  });
});
