/**
 * Authentication for the webhook delivery pull queue.
 *
 * **Primary credential: the agent access token (`aoc_`).** Three reasons it is
 * the right one rather than a project key:
 *
 * 1. It *is* the queue selector. The token names exactly one agent, so there is
 *    no "which queue do I drain" parameter to accept, validate, or get wrong,
 *    and no way to name someone else's queue.
 * 2. It is the credential the runtime already holds — `routes/container-config`
 *    hands `agent.accessToken` to the container today.
 * 3. Blast radius. A leaked `oc_` project key reads every secret, connection
 *    and policy in the project; a leaked `aoc_` drains one agent's webhook
 *    queue. A long-lived poller on someone's VM should carry the smaller one.
 *
 * **Secondary arm: an `oc_` project key plus an explicit `?agent=`.** Kept
 * because that is the key an existing runtime is already configured with, and
 * because ops and tests need to drain a queue by hand. The query param is
 * REQUIRED on this arm — a project key must never implicitly drain "some"
 * queue, so its absence is a 400, not a guess.
 */

import { db } from "@onecli/db";
import { createMiddleware } from "hono/factory";

import { authenticateApiKey } from "./auth/api-key";
import type { ApiEnv } from "../types";

export interface AgentAuthContext {
  agentId: string;
  identifier: string;
  projectId: string;
  organizationId: string;
}

const UNAUTHORIZED = {
  error: {
    message: "Invalid agent token or API key.",
    type: "authentication_error",
  },
} as const;

const AGENT_REQUIRED = {
  error: {
    message:
      "An agent identifier is required when authenticating with a project API key. Pass ?agent=<identifier>, or use the agent's access token.",
    type: "invalid_request_error",
  },
} as const;

const bearer = (header: string | null): string | null => {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token === "" ? null : token;
};

/**
 * `Agent.accessToken` is unique and stored verbatim, exactly like `ApiKey.key`
 * — so this is a single unique-index lookup, not a comparison, and there is no
 * timing surface to defend.
 */
const byAccessToken = async (
  token: string,
): Promise<AgentAuthContext | null> => {
  const agent = await db.agent.findUnique({
    where: { accessToken: token },
    select: {
      id: true,
      identifier: true,
      projectId: true,
      project: { select: { organizationId: true } },
    },
  });
  if (!agent) return null;
  return {
    agentId: agent.id,
    identifier: agent.identifier,
    projectId: agent.projectId,
    organizationId: agent.project.organizationId,
  };
};

export const agentAuth = createMiddleware<ApiEnv>(async (c, next) => {
  const token = bearer(c.req.header("authorization") ?? null);
  if (!token) return c.json(UNAUTHORIZED, 401);

  if (token.startsWith("aoc_")) {
    const agent = await byAccessToken(token);
    if (!agent) return c.json(UNAUTHORIZED, 401);
    c.set("agent", agent);
    return next();
  }

  // Project-key arm. `requireProject: true` so an org key with no
  // X-Project-Id can't reach here.
  const apiKeyAuth = await authenticateApiKey(c.req.raw, true);
  if (!apiKeyAuth || typeof apiKeyAuth === "string" || !apiKeyAuth.projectId) {
    return c.json(UNAUTHORIZED, 401);
  }

  const identifier = c.req.query("agent");
  if (!identifier) return c.json(AGENT_REQUIRED, 400);

  const agent = await db.agent.findFirst({
    where: { identifier, projectId: apiKeyAuth.projectId },
    select: { id: true, identifier: true, projectId: true },
  });
  // 401, not 404: an unknown identifier and an identifier in another project
  // are the same answer to a caller who should not learn which.
  if (!agent) return c.json(UNAUTHORIZED, 401);

  c.set("agent", {
    agentId: agent.id,
    identifier: agent.identifier,
    projectId: agent.projectId,
    organizationId: apiKeyAuth.organizationId,
  });
  return next();
});
