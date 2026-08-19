import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * Project agent-default-connections on REAL PostgreSQL: the template's own
 * constraints (unique per connection, cascade on project/connection delete)
 * plus the end-to-end apply step — a template written through
 * `setProjectAgentDefault` and applied through `applyProjectAgentDefaults`
 * must be readable back as a real grant via `getAgentGrants`, the same read
 * path the console and the gateway reflections use. Env-gated like the other
 * proof suites; see load-rules.pg.test.ts.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type Defaults = typeof import("./agent-default-connections-service");
type Grants = typeof import("./grants-service");

let db: Db;
let defaults: Defaults;
let grants: Grants;

const P = "adc-";
const ORG = `${P}org`;
const PROJECT = `${P}proj`;
const OTHER_PROJECT = `${P}other-proj`;
const CONN = `${P}conn`;
const CONN_ORG = `${P}conn-orgshared`;
const CONN_FOREIGN = `${P}conn-foreign`;

const SCOPE = { projectId: PROJECT, organizationId: ORG };

const reset = async () => {
  await db.policyRuleV2.deleteMany({
    where: {
      OR: [
        { projectId: { startsWith: P } },
        { organizationId: { startsWith: P } },
      ],
    },
  });
  await db.projectAgentDefaultConnection.deleteMany({
    where: { projectId: { startsWith: P } },
  });
  await db.agent.deleteMany({ where: { id: { startsWith: P } } });
  await db.appConnection.deleteMany({ where: { id: { startsWith: P } } });
  await db.project.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  ({ db } = await import("@onecli/db"));
  defaults = await import("./agent-default-connections-service");
  grants = await import("./grants-service");
  await reset();

  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.project.create({
    data: { id: PROJECT, name: PROJECT, organizationId: ORG },
  });
  await db.project.create({
    data: { id: OTHER_PROJECT, name: OTHER_PROJECT, organizationId: ORG },
  });
  const conn = (id: string, over: Record<string, unknown> = {}) =>
    db.appConnection.create({
      data: {
        id,
        provider: "gmail",
        scope: "project",
        status: "connected",
        projectId: PROJECT,
        label: id,
        ...over,
      },
    });
  await conn(CONN);
  await conn(CONN_ORG, {
    scope: "organization",
    projectId: null,
    organizationId: ORG,
  });
  await conn(CONN_FOREIGN, { projectId: OTHER_PROJECT });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.$disconnect();
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await db.policyRuleV2.deleteMany({
    where: {
      OR: [
        { projectId: { startsWith: P } },
        { organizationId: { startsWith: P } },
      ],
    },
  });
  await db.projectAgentDefaultConnection.deleteMany({
    where: { projectId: { startsWith: P } },
  });
  await db.agent.deleteMany({ where: { id: { startsWith: P } } });
});

describe.skipIf(!PROOF_URL)(
  "project agent-default-connections (real PostgreSQL)",
  () => {
    it("setProjectAgentDefault upserts — a second call on the same connection replaces the row, not duplicates", async () => {
      await defaults.setProjectAgentDefault(
        SCOPE,
        CONN,
        { access: "full", resources: null },
        null,
      );
      await defaults.setProjectAgentDefault(
        SCOPE,
        CONN,
        {
          access: "custom",
          allow: ["search_messages"],
          ask: [],
          resources: null,
        },
        null,
      );
      const rows = await db.projectAgentDefaultConnection.findMany({
        where: { projectId: PROJECT },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.access).toBe("custom");
    });

    it("rejects a connection outside the project's pool at the DB-fenced boundary", async () => {
      await expect(
        defaults.setProjectAgentDefault(
          SCOPE,
          CONN_FOREIGN,
          { access: "full", resources: null },
          null,
        ),
      ).rejects.toThrow("Connection not found");
    });

    it("accepts an org-shared connection", async () => {
      await defaults.setProjectAgentDefault(
        SCOPE,
        CONN_ORG,
        { access: "full", resources: null },
        null,
      );
      const list = await defaults.listProjectAgentDefaults(SCOPE);
      expect(list.map((d) => d.connectionId)).toContain(CONN_ORG);
    });

    it("cascades on connection delete — a dropped connection can't leave a dangling template row", async () => {
      const conn = await db.appConnection.create({
        data: {
          id: `${P}cascade-conn`,
          provider: "gmail",
          scope: "project",
          status: "connected",
          projectId: PROJECT,
        },
      });
      await defaults.setProjectAgentDefault(
        SCOPE,
        conn.id,
        { access: "full", resources: null },
        null,
      );
      await db.appConnection.delete({ where: { id: conn.id } });
      const rows = await db.projectAgentDefaultConnection.findMany({
        where: { connectionId: conn.id },
      });
      expect(rows).toHaveLength(0);
    });

    it("end-to-end: a template applied at agent creation reads back as a real grant via getAgentGrants", async () => {
      await defaults.setProjectAgentDefault(
        SCOPE,
        CONN,
        { access: "full", resources: null },
        null,
      );

      const agent = await db.agent.create({
        data: {
          id: `${P}new-agent`,
          projectId: PROJECT,
          name: "new agent",
          identifier: `${P}new-agent`,
          accessToken: "aoc_adc_test_token",
          secretMode: "selective",
        },
      });

      await defaults.applyProjectAgentDefaults(SCOPE, agent.id);

      const result = await grants.getAgentGrants(SCOPE, agent.id);
      expect(result.connections).toHaveLength(1);
      expect(result.connections[0]).toMatchObject({
        connectionId: CONN,
        access: "full",
      });
    });

    it("removeProjectAgentDefault: a removed default is no longer applied to a subsequently created agent", async () => {
      await defaults.setProjectAgentDefault(
        SCOPE,
        CONN,
        { access: "full", resources: null },
        null,
      );
      await defaults.removeProjectAgentDefault(SCOPE, CONN);

      const agent = await db.agent.create({
        data: {
          id: `${P}no-defaults-agent`,
          projectId: PROJECT,
          name: "no defaults agent",
          identifier: `${P}no-defaults-agent`,
          accessToken: "aoc_adc_test_token_2",
          secretMode: "selective",
        },
      });
      await defaults.applyProjectAgentDefaults(SCOPE, agent.id);

      const result = await grants.getAgentGrants(SCOPE, agent.id);
      expect(result.connections).toHaveLength(0);
    });
  },
);
