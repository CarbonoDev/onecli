import { db } from "@onecli/db";
import { listProjects } from "./project-service";

/**
 * Org-scope gateway usage: request volume for the rolling window, split by
 * agent.
 *
 * ## What `request_logs` actually is — read this before adding a metric
 *
 * It is NOT a record of total gateway traffic. The gateway's writer
 * (`apps/gateway/src/telemetry.rs`, `insert_batch`) persists a row only when
 * the request injected a credential OR the policy decision was anything other
 * than a plain allow:
 *
 * ```rust
 * .filter(|e| e.injected || !matches!(e.decision, RequestDecision::Allowed))
 * ```
 *
 * A pass-through on the agent's own key is never written. "Total gateway
 * requests" is therefore NOT COMPUTABLE from this table, and no caller may
 * label these numbers that way — the UI says "recorded gateway requests" and
 * explains the gap in a tooltip. `integrationCalls` (rows with
 * `injection_count > 0`) is exact, because injection is precisely the
 * condition that guarantees a row.
 *
 * Only the typed columns are read: `agent_id`, `project_id`, `injection_count`,
 * `created_at`. `extra_data` is deliberately untouched — the OSS gateway's
 * INSERT above never writes it (only `update_batch` does, for approval
 * resolutions), so anything derived from it would be null for ~every row.
 */

/**
 * Rolling lookback for the usage period. Bounded for the same reason
 * `LAST_SEEN_WINDOW_MS` is (see `lib/agent-activity.ts`): the group-by is
 * `(project_id, created_at)`-indexed, so a `createdAt >= start` predicate makes
 * it a range scan instead of a walk of every project's whole log history.
 * `request_logs` has no retention or pruning anywhere in the repo, so an
 * unbounded aggregate grows without limit by construction.
 */
export const USAGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface UsageAgentRow {
  agentId: string;
  /**
   * Null when the id no longer resolves to an agent. `request_logs.agent_id`
   * carries NO foreign key, so rows outlive the agent that made them; the row
   * is kept (rendered as "Deleted agent") rather than dropped, because
   * dropping it would break the invariant that the rows sum to the totals.
   */
  agentName: string | null;
  requests: number;
  integrationCalls: number;
}

export interface UsageSummary {
  /** Explicit bounds so the UI label always describes what was measured. */
  periodStart: string;
  periodEnd: string;
  requests: number;
  integrationCalls: number;
  agents: UsageAgentRow[];
}

const zeroSummary = (periodStart: Date, periodEnd: Date): UsageSummary => ({
  periodStart: periodStart.toISOString(),
  periodEnd: periodEnd.toISOString(),
  requests: 0,
  integrationCalls: 0,
  agents: [],
});

/**
 * Usage for every project the caller may reach in this org.
 *
 * `listProjects` is BOTH the org fence and the authorization fence, and it has
 * to be: `request_logs` has no `organization_id` column, so resolving the
 * project ids the caller may see is the only way to scope the aggregate to an
 * org at all. Consequently this read is member-visible with per-project
 * fencing rather than admin-only — a member sees exactly their bound projects'
 * traffic. A caller with no reachable projects gets a ZEROED summary carrying
 * real period bounds, never a 403: "you can see nothing" is an empty result,
 * not a permission error (the `GET /projects` precedent).
 */
export const getOrganizationUsage = async (
  organizationId: string,
  userId: string,
  now: number = Date.now(),
): Promise<UsageSummary> => {
  const periodEnd = new Date(now);
  const periodStart = new Date(now - USAGE_WINDOW_MS);

  const projectIds = (await listProjects(organizationId, userId)).map(
    (p) => p.id,
  );
  if (projectIds.length === 0) return zeroSummary(periodStart, periodEnd);

  // Bounded at BOTH ends. `lt: periodEnd` is not redundant with "now": a
  // gateway with a fast clock writes a `created_at` in the future, which an
  // open-ended `gte` would count toward a window the UI labels as ending now.
  // With the upper bound, the label is exactly true.
  const where = {
    projectId: { in: projectIds },
    createdAt: { gte: periodStart, lt: periodEnd },
  };

  // ┌─ THE CLAMP AT `Math.min` BELOW IS THE GUARANTEE. DO NOT REMOVE IT. ─┐
  //
  // It is tempting to read the `$transaction` as making both aggregates see
  // one snapshot, which would make the clamp redundant. It does NOT.
  // `$transaction([...])` runs at the database's default isolation level and
  // nothing sets one (no `isolationLevel` anywhere in the repo;
  // `packages/db/src/index.ts` constructs a bare `PrismaClient`). Postgres
  // defaults to READ COMMITTED, under which every statement takes its own
  // snapshot — a row committed between the two `groupBy`s is visible to the
  // second one but not the first.
  //
  // So the inversion is genuinely reachable: a request landing mid-pair can be
  // counted by the injected query and missed by the total one, yielding
  // `integrationCalls > requests` — the self-contradicting page this design
  // exists to prevent. `Math.min` is what actually prevents it.
  //
  // The transaction is kept for connection hygiene (one connection, one
  // round-trip pair), not for isolation. Raising the isolation to
  // `RepeatableRead` would also close the window, but it buys nothing the
  // clamp doesn't already cover and costs a heavier transaction.
  //
  // The two queries are hoisted into consts rather than written inline in the
  // array: Prisma's `groupBy` return type is inferred from the argument
  // literal, and inside `$transaction([...])` that inference collapses (it
  // demands an explicit `orderBy` and widens `_count` to `true | {...}`).
  // Assigning first keeps the precise per-call type; `$transaction` then just
  // sequences the already-typed promises.
  // The two queries are hoisted into consts rather than written inline in the
  // array: Prisma's `groupBy` return type is inferred from the argument
  // literal, and inside `$transaction([...])` that inference collapses (it
  // demands an explicit `orderBy` and widens `_count` to `true | {...}`).
  // Assigning first keeps the precise per-call type; `$transaction` then just
  // sequences the already-typed promises.
  const totalsQuery = db.requestLog.groupBy({
    by: ["agentId"],
    where,
    _count: { _all: true },
  });
  const injectedQuery = db.requestLog.groupBy({
    by: ["agentId"],
    where: { ...where, injectionCount: { gt: 0 } },
    _count: { _all: true },
  });
  const [requestRows, injectedRows] = await db.$transaction([
    totalsQuery,
    injectedQuery,
  ]);

  const injectedByAgent = new Map(
    injectedRows.map((r) => [r.agentId, r._count._all]),
  );

  // Fenced by `projectId` as well as `id`: the ids came from rows inside the
  // caller's projects, and the name lookup must not widen that.
  const agentIds = requestRows.map((r) => r.agentId);
  const namedAgents = agentIds.length
    ? await db.agent.findMany({
        where: { id: { in: agentIds }, projectId: { in: projectIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(namedAgents.map((a) => [a.id, a.name]));

  const agents: UsageAgentRow[] = requestRows
    .map((row) => {
      const requests = row._count._all;
      return {
        agentId: row.agentId,
        agentName: nameById.get(row.agentId) ?? null,
        requests,
        // THE invariant `integrationCalls <= requests` rests on — see the
        // isolation-level note above. Not redundant with the transaction.
        integrationCalls: Math.min(
          injectedByAgent.get(row.agentId) ?? 0,
          requests,
        ),
      };
    })
    // Busiest first; `agentId` breaks ties so the order is stable across reads.
    .sort(
      (a, b) => b.requests - a.requests || a.agentId.localeCompare(b.agentId),
    );

  // Totals are SUMMED FROM THE ROWS, never queried separately, so the stat
  // cards and the by-agent table can never disagree.
  return {
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    requests: agents.reduce((n, a) => n + a.requests, 0),
    integrationCalls: agents.reduce((n, a) => n + a.integrationCalls, 0),
    agents,
  };
};
