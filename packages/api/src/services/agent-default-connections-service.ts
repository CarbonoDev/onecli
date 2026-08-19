import { db, Prisma } from "@onecli/db";
import { ServiceError } from "./errors";
import { getPolicyValidator, getRuleActionGate } from "../providers";
import { assertToolIdsValid } from "../apps/app-permissions/validate";
import { logger } from "../lib/logger";
import { gatedActions, type PolicyScopeBase } from "./policy-service";
import { setConnectionGrant } from "./grants-service";
import type { GrantScope } from "./grants-service";
import {
  isSessionPolicy,
  type SessionPolicyInput,
} from "../validations/policy";
import type { ConnectionGrantInput } from "../validations/grants";

/**
 * Project-level default-connections template (plans/agent-default-connections.md).
 *
 * A row here is INTENT, not a grant: "when a brand-new agent is born in this
 * project, attach it to this connection with this access." Applying it reuses
 * `setConnectionGrant` — the exact door the manual attach UI writes through —
 * so a default-applied grant is indistinguishable from a manually-attached one
 * afterward (same rule stack, same reflections, same detach flow). This file
 * only owns the template CRUD and the apply step; it compiles nothing itself.
 */

const jsonInput = (
  value: unknown,
): Prisma.InputJsonValue | Prisma.NullTypes.JsonNull => {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
};

const base = (scope: GrantScope): PolicyScopeBase => ({
  scope: "project",
  projectId: scope.projectId,
});

/** Mirrors grants-service's own pool: a project's own connections plus
 * org-shared ones — a default template can point at either, same as a manual
 * grant can. */
const requireConnectionInPool = async (
  scope: GrantScope,
  connectionId: string,
) => {
  const connection = await db.appConnection.findFirst({
    where: {
      id: connectionId,
      OR: [
        { projectId: scope.projectId },
        { organizationId: scope.organizationId, scope: "organization" },
      ],
    },
    select: {
      id: true,
      provider: true,
      label: true,
      scope: true,
      metadata: true,
    },
  });
  if (!connection) throw new ServiceError("NOT_FOUND", "Connection not found.");
  return connection;
};

export interface ProjectAgentDefault {
  connectionId: string;
  provider: string;
  label: string | null;
  scope: "project" | "organization";
  access: "full" | "custom";
  allow: string[];
  ask: string[];
  resources: SessionPolicyInput | null;
}

const toResources = (
  value: Prisma.JsonValue | null,
): SessionPolicyInput | null => (isSessionPolicy(value) ? value : null);

export const listProjectAgentDefaults = async (
  scope: GrantScope,
): Promise<ProjectAgentDefault[]> => {
  const rows = await db.projectAgentDefaultConnection.findMany({
    where: { projectId: scope.projectId },
    include: {
      connection: { select: { provider: true, label: true, scope: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    connectionId: r.connectionId,
    provider: r.connection.provider,
    label: r.connection.label,
    scope: r.connection.scope as "project" | "organization",
    access: r.access as "full" | "custom",
    allow: r.allow,
    ask: r.ask,
    resources: toResources(r.resources),
  }));
};

/**
 * Set (create or replace) the project's default for one connection. Runs the
 * same gates a manual grant would (tool-id validity, the approval-entitlement
 * gate on `ask`, the resources validator) — a default that skips them would
 * let a project configure, at apply time, access an org without the
 * entitlement could never grant by hand.
 */
export const setProjectAgentDefault = async (
  scope: GrantScope,
  connectionId: string,
  input: ConnectionGrantInput,
  userId: string | null,
): Promise<void> => {
  const connection = await requireConnectionInPool(scope, connectionId);

  if (input.access === "custom") {
    assertToolIdsValid(connection.provider, [...input.allow, ...input.ask]);
    if (input.ask.length > 0) {
      await getRuleActionGate().assertAllowed(
        base(scope),
        gatedActions({ requireApproval: true }),
      );
    }
  }

  const resources = input.resources ?? null;
  if (resources !== null) {
    await getPolicyValidator().validate(
      scope.organizationId,
      connection.provider,
      connection.metadata as Record<string, unknown> | null,
      resources,
    );
  }

  await db.projectAgentDefaultConnection.upsert({
    where: {
      projectId_connectionId: { projectId: scope.projectId, connectionId },
    },
    create: {
      projectId: scope.projectId,
      connectionId,
      access: input.access,
      allow: input.access === "custom" ? input.allow : [],
      ask: input.access === "custom" ? input.ask : [],
      resources: jsonInput(resources),
      createdByUserId: userId,
    },
    update: {
      access: input.access,
      allow: input.access === "custom" ? input.allow : [],
      ask: input.access === "custom" ? input.ask : [],
      resources: jsonInput(resources),
    },
  });
};

export const removeProjectAgentDefault = async (
  scope: GrantScope,
  connectionId: string,
): Promise<void> => {
  await db.projectAgentDefaultConnection.deleteMany({
    where: { projectId: scope.projectId, connectionId },
  });
};

/**
 * Apply the project's default templates to a freshly created agent. Called
 * once, right after `createAgent`, from the `afterCreateAgent` resource hook —
 * NEVER from an interactive route, so this intentionally does not audit (same
 * as `ossNewProjectPolicySeeder`: a system-triggered write has no acting user
 * to attribute it to). Best-effort per default: one connection's grant
 * failing (e.g. its catalog tool ids drifted since the template was set) must
 * not stop the others from applying, and must never fail agent creation
 * itself — the caller (`routes/agents.ts`) has already committed the agent
 * row by the time this runs.
 */
export const applyProjectAgentDefaults = async (
  scope: GrantScope,
  agentId: string,
): Promise<void> => {
  const defaults = await db.projectAgentDefaultConnection.findMany({
    where: { projectId: scope.projectId },
    select: {
      connectionId: true,
      access: true,
      allow: true,
      ask: true,
      resources: true,
    },
  });
  for (const d of defaults) {
    const input: ConnectionGrantInput =
      d.access === "custom"
        ? {
            access: "custom",
            allow: d.allow,
            ask: d.ask,
            resources: toResources(d.resources),
          }
        : { access: "full", resources: toResources(d.resources) };
    try {
      await setConnectionGrant(scope, agentId, d.connectionId, input, null);
    } catch (err) {
      logger.warn(
        {
          projectId: scope.projectId,
          agentId,
          connectionId: d.connectionId,
          err,
        },
        "Failed to apply project agent default (best-effort, not fatal)",
      );
    }
  }
};
