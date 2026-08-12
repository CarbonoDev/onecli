"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PageHeader } from "@dashboard/page-header";
import { TryDemoCommand } from "@/app/(dashboard)/_components/try-demo-command";
import { useAgents } from "@/hooks/use-agents";
import { useInstallInfo } from "@/hooks/use-install-info";
import { IS_CLOUD } from "@/lib/env";
import {
  CODING_TOOLS,
  buildCliInstallCommand,
  buildManualInstallCommand,
  buildRunCommand,
} from "@/lib/install-command";
import { AgentContextSelect } from "./agent-context-select";
import { InstallStep } from "./install-step";
import { SetupStatusCard } from "./setup-status-card";
import { ToolPills, type ToolSelection } from "./tool-pills";

export const InstallContent = () => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: agents = [] } = useAgents();
  const { data: installInfo } = useInstallInfo();

  const [tool, setTool] = useState<ToolSelection>("claude-code");

  // The URL is the single source of truth for the agent choice:
  // `?agent=<identifier>` — how the org-level Get Started picker deep-links in,
  // and what the select below writes. No param = the project's default agent.
  const requestedIdentifier = searchParams.get("agent");
  const selectedAgent =
    (requestedIdentifier
      ? agents.find((a) => a.identifier === requestedIdentifier)
      : undefined) ??
    agents.find((a) => a.isDefault) ??
    agents[0];

  const selectAgent = (agentId: string) => {
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) return;
    // Default agent = clean URL, matching the no-param command it produces.
    router.replace(
      agent.isDefault
        ? pathname
        : `${pathname}?agent=${encodeURIComponent(agent.identifier)}`,
      { scroll: false },
    );
  };

  const activeTool =
    tool === "other" ? undefined : CODING_TOOLS.find((t) => t.id === tool);

  // The default agent writes no pin: `onecli run` already resolves to the
  // project default server-side, so the command stays clean and portable.
  const pinIdentifier =
    selectedAgent && !selectedAgent.isDefault
      ? selectedAgent.identifier
      : undefined;

  const installCommand =
    IS_CLOUD && installInfo?.apiKey
      ? buildCliInstallCommand(
          {
            apiUrl: installInfo.apiUrl,
            appUrl: installInfo.appUrl,
            apiKey: installInfo.apiKey,
          },
          { tool: activeTool?.id, agentIdentifier: pinIdentifier },
        )
      : null;

  const runAlias = activeTool?.runAlias ?? "<your-command>";
  const runCommand = buildRunCommand(runAlias);
  const overrideExample = buildRunCommand(
    runAlias,
    pinIdentifier ?? selectedAgent?.identifier ?? "my-agent",
  );

  // Self-host / OSS: the one-liner endpoint is cloud-only, so spell the same
  // setup out manually (with this project's real key once loaded).
  const manualCommand = buildManualInstallCommand(installInfo, {
    agentIdentifier: pinIdentifier,
  });

  // Both branches of step 2 embed the project API key verbatim, so the block
  // renders masked until the user reveals it. Undefined — never "" — while the
  // key is still loading: the command then shows the `oc_...` placeholder and
  // there is nothing to mask.
  const installSecret = installInfo?.apiKey || undefined;

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader
          title="Install"
          description="Run your coding agent through OneCLI — credentials are injected at the gateway, never stored on your machine."
        />
        <AgentContextSelect
          agents={agents}
          value={selectedAgent?.id ?? ""}
          onChange={selectAgent}
        />
      </div>

      <div className="flex max-w-2xl flex-col gap-2">
        {/* role="list" is NOT redundant here: this <ol> is explicitly
            `list-none` (the steps render their own numbers), and WebKit drops
            the implicit list role when list-style is none — so on
            Safari/VoiceOver this would announce no item count. Do not strip as
            redundant ARIA. */}
        <ol role="list" className="list-none">
          <InstallStep
            number={1}
            title="Choose your tool"
            description="The commands below adapt to your pick."
          >
            <ToolPills value={tool} onChange={setTool} />
          </InstallStep>

          <InstallStep
            number={2}
            title="Install & sign in"
            description={
              installCommand
                ? `One command: installs the CLI and signs in to this project${
                    pinIdentifier
                      ? `, pinning this machine to ${selectedAgent?.name ?? pinIdentifier}`
                      : ""
                  }.`
                : "Install the CLI, point it at this instance, and sign in."
            }
          >
            <TryDemoCommand
              command={installCommand ?? manualCommand}
              secret={installSecret}
            />
            {/* Only once there IS a key: while the query is pending the block
                shows the `oc_...` placeholder, and warning about a key that
                isn't on screen yet is just noise. */}
            {installSecret && (
              <p className="text-muted-foreground mt-2 text-xs">
                This command carries your project API key. Rotate it in{" "}
                <Link href="/settings/api-keys" className="underline">
                  Settings → API keys
                </Link>{" "}
                if it is ever shared.
              </p>
            )}
            {installCommand && pinIdentifier && (
              <p className="text-muted-foreground mt-2 text-xs">
                Already have the CLI?{" "}
                <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">
                  onecli config set agent {pinIdentifier}
                </code>{" "}
                does the pinning on its own.
              </p>
            )}
          </InstallStep>

          <InstallStep
            number={3}
            title="Run it"
            description={
              activeTool
                ? `Launches ${activeTool.name} behind the gateway — proxy and CA are configured for you.`
                : "Launches any command behind the gateway — proxy and CA are configured for you."
            }
            last
          >
            <TryDemoCommand command={runCommand} />
            <p className="text-muted-foreground mt-2 text-xs">
              One-off identity switch:{" "}
              <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">
                {overrideExample}
              </code>
            </p>
          </InstallStep>
        </ol>

        <SetupStatusCard agent={selectedAgent} />
      </div>
    </>
  );
};
