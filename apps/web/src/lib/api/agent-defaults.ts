import { apiGet, apiPut, apiDelete } from "./client";
import type { ConnectionGrantInput, ProjectAgentDefault } from "./types";

// The project-level "which connections should a new agent start with"
// template. Project scope only (mirrors grants.ts's shape one level up) — a
// default is inherently a property of the project new agents are born into.

export const list = () => apiGet<ProjectAgentDefault[]>("/v1/agent-defaults");

export const set = (connectionId: string, input: ConnectionGrantInput) =>
  apiPut<ProjectAgentDefault[]>(
    `/v1/agent-defaults/connections/${connectionId}`,
    input,
  );

export const remove = (connectionId: string) =>
  apiDelete(`/v1/agent-defaults/connections/${connectionId}`);
