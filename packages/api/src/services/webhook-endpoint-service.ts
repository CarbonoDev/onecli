/**
 * CRUD for webhook ingest endpoints.
 *
 * Project-scoped throughout: every query carries `projectId` in its `where`, so
 * a guessed uuid from another tenant reads and writes nothing. These are
 * project-only resources, so the full `ResourceScope` machinery (which exists
 * for the project→org fallback) would be noise here.
 */

import { db, Prisma } from "@onecli/db";

import { getCrypto } from "../providers";
import { ServiceError } from "./errors";
import {
  generateWebhookPublicId,
  generateWebhookSecret,
} from "./webhook/generate";
import { getVerifier } from "./webhook/verifiers";
import type {
  CreateWebhookEndpointInput,
  UpdateWebhookEndpointInput,
} from "../validations/webhook";

export interface WebhookEndpointDto {
  id: string;
  publicId: string;
  slug: string;
  name: string;
  verification: string;
  /** Whether a secret is stored. The value itself is only ever returned by `get`. */
  hasSecret: boolean;
  template: string;
  agentId: string;
  agentName: string;
  agentIdentifier: string;
  routing: unknown;
  enabled: boolean;
  rateLimitPerMin: number;
  /** The path to append to the deployment's public origin. */
  ingestPath: string;
  lastDeliveryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const ENDPOINT_SELECT = {
  id: true,
  publicId: true,
  slug: true,
  name: true,
  verification: true,
  secret: true,
  template: true,
  agentId: true,
  routing: true,
  enabled: true,
  rateLimitPerMin: true,
  lastDeliveryAt: true,
  createdAt: true,
  updatedAt: true,
  agent: { select: { name: true, identifier: true } },
} as const;

type EndpointRow = Prisma.WebhookEndpointGetPayload<{
  select: typeof ENDPOINT_SELECT;
}>;

export const ingestPathFor = (publicId: string) => `/v1/hooks/${publicId}`;

const toDto = (row: EndpointRow): WebhookEndpointDto => ({
  id: row.id,
  publicId: row.publicId,
  slug: row.slug,
  name: row.name,
  verification: row.verification,
  hasSecret: row.secret !== null,
  template: row.template,
  agentId: row.agentId,
  agentName: row.agent.name,
  agentIdentifier: row.agent.identifier,
  routing: row.routing ?? null,
  enabled: row.enabled,
  rateLimitPerMin: row.rateLimitPerMin,
  ingestPath: ingestPathFor(row.publicId),
  lastDeliveryAt: row.lastDeliveryAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const isUniqueViolation = (error: unknown, target: string) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2002" &&
  JSON.stringify(error.meta?.target ?? "").includes(target);

const requireAgent = async (projectId: string, agentId: string) => {
  const agent = await db.agent.findFirst({
    where: { id: agentId, projectId },
    select: { id: true },
  });
  if (!agent) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "Target agent not found in this project",
    );
  }
};

const routingValue = (
  routing: Record<string, unknown> | null | undefined,
): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined => {
  if (routing === undefined) return undefined;
  if (routing === null) return Prisma.JsonNull;
  return routing as Prisma.InputJsonValue;
};

/**
 * A verifier that requires a secret must have one. Mint it rather than asking
 * the operator to invent one — the value is pasted into a provider's config,
 * never typed from memory.
 */
const secretFor = async (verification: string): Promise<string | null> => {
  const verifier = getVerifier(verification);
  if (!verifier) {
    throw new ServiceError("UNPROCESSABLE", "Unknown verification type");
  }
  return verifier.requiresSecret ? generateWebhookSecret() : null;
};

export const listWebhookEndpoints = async (
  projectId: string,
): Promise<WebhookEndpointDto[]> => {
  const rows = await db.webhookEndpoint.findMany({
    where: { projectId },
    select: ENDPOINT_SELECT,
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toDto);
};

const findEndpoint = async (projectId: string, id: string) => {
  const row = await db.webhookEndpoint.findFirst({
    where: { id, projectId },
    select: ENDPOINT_SELECT,
  });
  if (!row) throw new ServiceError("NOT_FOUND", "Webhook endpoint not found");
  return row;
};

export const getWebhookEndpoint = async (
  projectId: string,
  id: string,
): Promise<WebhookEndpointDto> => toDto(await findEndpoint(projectId, id));

/**
 * The detail read returns the plaintext secret.
 *
 * Re-readable on purpose, matching every other credential here (the project API
 * key on the overview page, an agent's access token in its list row). A webhook
 * secret has to be re-pasted into a provider's config months after it was
 * minted; a show-once flow turns a copy/paste slip into a forced rotation on
 * the provider's side. Kept off the LIST endpoint so a page render never fans
 * out N decrypts.
 */
export const getWebhookEndpointWithSecret = async (
  projectId: string,
  id: string,
): Promise<WebhookEndpointDto & { secret: string | null }> => {
  const row = await findEndpoint(projectId, id);
  return {
    ...toDto(row),
    secret: row.secret ? await getCrypto().decrypt(row.secret) : null,
  };
};

export const createWebhookEndpoint = async (
  projectId: string,
  input: CreateWebhookEndpointInput,
): Promise<WebhookEndpointDto & { secret: string | null }> => {
  await requireAgent(projectId, input.agentId);
  const secret = await secretFor(input.verification);

  try {
    const row = await db.webhookEndpoint.create({
      data: {
        projectId,
        publicId: generateWebhookPublicId(),
        slug: input.slug,
        name: input.name,
        verification: input.verification,
        secret: secret ? await getCrypto().encrypt(secret) : null,
        template: input.template,
        agentId: input.agentId,
        routing: routingValue(input.routing),
        enabled: input.enabled,
        rateLimitPerMin: input.rateLimitPerMin,
      },
      select: ENDPOINT_SELECT,
    });
    return { ...toDto(row), secret };
  } catch (error) {
    if (isUniqueViolation(error, "slug")) {
      throw new ServiceError(
        "CONFLICT",
        "A webhook endpoint with this slug already exists",
      );
    }
    throw error;
  }
};

export const updateWebhookEndpoint = async (
  projectId: string,
  id: string,
  input: UpdateWebhookEndpointInput,
): Promise<WebhookEndpointDto & { secret: string | null }> => {
  const existing = await findEndpoint(projectId, id);
  if (input.agentId) await requireAgent(projectId, input.agentId);

  // Changing the verification type invalidates the stored secret: a GitHub HMAC
  // key and a shared token are not interchangeable, and silently reusing one as
  // the other would leave the operator with a secret that verifies nothing.
  const verificationChanged =
    input.verification !== undefined &&
    input.verification !== existing.verification;
  const rotated = verificationChanged
    ? await secretFor(input.verification as string)
    : null;

  try {
    const row = await db.webhookEndpoint.update({
      where: { id },
      data: {
        slug: input.slug,
        name: input.name,
        verification: input.verification,
        ...(verificationChanged
          ? { secret: rotated ? await getCrypto().encrypt(rotated) : null }
          : {}),
        template: input.template,
        agentId: input.agentId,
        routing: routingValue(input.routing),
        enabled: input.enabled,
        rateLimitPerMin: input.rateLimitPerMin,
      },
      select: ENDPOINT_SELECT,
    });
    return { ...toDto(row), secret: rotated };
  } catch (error) {
    if (isUniqueViolation(error, "slug")) {
      throw new ServiceError(
        "CONFLICT",
        "A webhook endpoint with this slug already exists",
      );
    }
    throw error;
  }
};

export const deleteWebhookEndpoint = async (
  projectId: string,
  id: string,
): Promise<{ id: string; slug: string; deletedDeliveries: number }> => {
  const existing = await findEndpoint(projectId, id);
  // Counted before the cascade so the audit metadata can say how much history
  // went with it. A count, never the ids — the house convention.
  const deletedDeliveries = await db.webhookDelivery.count({
    where: { endpointId: existing.id },
  });
  await db.webhookEndpoint.delete({ where: { id: existing.id } });
  return { id: existing.id, slug: existing.slug, deletedDeliveries };
};

export const rotateWebhookSecret = async (
  projectId: string,
  id: string,
): Promise<{ id: string; slug: string; secret: string | null }> => {
  const existing = await findEndpoint(projectId, id);
  const secret = await secretFor(existing.verification);

  await db.webhookEndpoint.update({
    where: { id: existing.id },
    data: { secret: secret ? await getCrypto().encrypt(secret) : null },
  });
  return { id: existing.id, slug: existing.slug, secret };
};

/** Fire-and-forget from the ingest path; a failure must never fail the ingest. */
export const touchLastDeliveryAt = async (id: string): Promise<void> => {
  await db.webhookEndpoint.update({
    where: { id },
    data: { lastDeliveryAt: new Date() },
  });
};
