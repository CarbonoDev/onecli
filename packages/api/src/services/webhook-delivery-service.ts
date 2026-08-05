/**
 * Reading and replaying the delivery log.
 *
 * The pagination is keyset, copied from `request-log-service` rather than the
 * `/v1/org/*` opaque-cursor convention: deliveries are an activity log, and
 * they should page the way the other activity log in this app pages.
 */

import { db, Prisma } from "@onecli/db";

import { ServiceError } from "./errors";
import { DELIVERY_STATUS } from "./webhook/constants";
import { notifyPending } from "./webhook/notify";
import { renderTemplate } from "./webhook/render";
import type { DeliveryListQuery } from "../validations/webhook";

export interface DeliveryRowDto {
  id: string;
  endpointId: string;
  status: string;
  discardReason: string | null;
  event: string | null;
  dedupeKey: string | null;
  duplicateCount: number;
  attempts: number;
  bodyBytes: number;
  lastError: string | null;
  replayOfId: string | null;
  receivedAt: string;
  deliveredAt: string | null;
  createdAt: string;
  /**
   * Derived, never stored: a row is in flight when it is pending, carries a
   * claim, and the lease has not lapsed. Keeping this out of the `status`
   * column is what lets the claim predicate stay a single index-friendly arm.
   */
  inFlight: boolean;
}

export interface DeliveryDetailDto extends DeliveryRowDto {
  payload: unknown;
  headers: unknown;
  renderedText: string | null;
  renderWarnings: string[];
  claimedBy: string | null;
  claimedAt: string | null;
}

export interface DeliveryPage {
  deliveries: DeliveryRowDto[];
  nextCursor: { createdAt: string; id: string } | null;
}

const ROW_SELECT = {
  id: true,
  endpointId: true,
  status: true,
  discardReason: true,
  eventType: true,
  dedupeKey: true,
  duplicateCount: true,
  attempts: true,
  bodyBytes: true,
  lastError: true,
  replayOfId: true,
  receivedAt: true,
  deliveredAt: true,
  createdAt: true,
  claimId: true,
  availableAt: true,
} as const;

const DETAIL_SELECT = {
  ...ROW_SELECT,
  payload: true,
  headers: true,
  renderedText: true,
  renderWarnings: true,
  claimedBy: true,
  claimedAt: true,
} as const;

type Row = Prisma.WebhookDeliveryGetPayload<{ select: typeof ROW_SELECT }>;
type DetailRow = Prisma.WebhookDeliveryGetPayload<{
  select: typeof DETAIL_SELECT;
}>;

const toRow = (row: Row, now = Date.now()): DeliveryRowDto => ({
  id: row.id,
  endpointId: row.endpointId,
  status: row.status,
  discardReason: row.discardReason,
  event: row.eventType,
  dedupeKey: row.dedupeKey,
  duplicateCount: row.duplicateCount,
  attempts: row.attempts,
  bodyBytes: row.bodyBytes,
  lastError: row.lastError,
  replayOfId: row.replayOfId,
  receivedAt: row.receivedAt.toISOString(),
  deliveredAt: row.deliveredAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  inFlight:
    row.status === DELIVERY_STATUS.PENDING &&
    row.claimId !== null &&
    row.availableAt.getTime() > now,
});

const toDetail = (row: DetailRow): DeliveryDetailDto => ({
  ...toRow(row),
  payload: row.payload ?? null,
  headers: row.headers,
  renderedText: row.renderedText,
  renderWarnings: row.renderWarnings,
  claimedBy: row.claimedBy,
  claimedAt: row.claimedAt?.toISOString() ?? null,
});

/**
 * Pure and synchronous so the cursor logic is unit-testable without a database
 * — the same reason `buildActivityWhere` exists next door.
 */
export const buildDeliveryWhere = (
  endpointId: string,
  params: Pick<DeliveryListQuery, "status" | "cursorCreatedAt" | "cursorId">,
): Prisma.WebhookDeliveryWhereInput => {
  const where: Prisma.WebhookDeliveryWhereInput = { endpointId };
  if (params.status) where.status = params.status;
  if (params.cursorCreatedAt && params.cursorId) {
    // The id tie-break matters: two deliveries can share a millisecond, and
    // without it a page boundary silently drops or repeats one.
    where.OR = [
      { createdAt: { lt: new Date(params.cursorCreatedAt) } },
      {
        createdAt: new Date(params.cursorCreatedAt),
        id: { lt: params.cursorId },
      },
    ];
  }
  return where;
};

const requireEndpoint = async (projectId: string, endpointId: string) => {
  const endpoint = await db.webhookEndpoint.findFirst({
    where: { id: endpointId, projectId },
    select: { id: true },
  });
  if (!endpoint)
    throw new ServiceError("NOT_FOUND", "Webhook endpoint not found");
  return endpoint;
};

export const listWebhookDeliveries = async (
  projectId: string,
  endpointId: string,
  params: DeliveryListQuery,
): Promise<DeliveryPage> => {
  await requireEndpoint(projectId, endpointId);

  const rows = await db.webhookDelivery.findMany({
    where: buildDeliveryWhere(endpointId, params),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    // One extra row is how "is there a next page?" is answered without a count.
    take: params.limit + 1,
    select: ROW_SELECT,
  });

  const hasMore = rows.length > params.limit;
  const page = hasMore ? rows.slice(0, params.limit) : rows;
  const last = page[page.length - 1];

  return {
    deliveries: page.map((row) => toRow(row)),
    nextCursor:
      hasMore && last
        ? { createdAt: last.createdAt.toISOString(), id: last.id }
        : null,
  };
};

export const getWebhookDelivery = async (
  projectId: string,
  deliveryId: string,
): Promise<DeliveryDetailDto> => {
  const row = await db.webhookDelivery.findFirst({
    where: { id: deliveryId, projectId },
    select: DETAIL_SELECT,
  });
  if (!row) throw new ServiceError("NOT_FOUND", "Delivery not found");
  return toDetail(row);
};

/**
 * Replay inserts a NEW delivery rather than resetting the old one.
 *
 * That is what makes template edits take effect (the copy is rendered with the
 * endpoint's *current* template) while leaving the original row intact as
 * history. `dedupeKey` is dropped so the copy cannot collide with the original
 * on the unique index, and `attempts` starts fresh.
 */
export const replayWebhookDelivery = async (
  projectId: string,
  deliveryId: string,
): Promise<{ id: string; replayOfId: string; endpointId: string }> => {
  const original = await db.webhookDelivery.findFirst({
    where: { id: deliveryId, projectId },
    select: {
      id: true,
      endpointId: true,
      eventType: true,
      payload: true,
      headers: true,
      bodyBytes: true,
      endpoint: {
        select: { id: true, slug: true, template: true, agentId: true },
      },
    },
  });
  if (!original) throw new ServiceError("NOT_FOUND", "Delivery not found");
  if (original.payload === null) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "This delivery was rejected before its payload was stored, so it cannot be replayed",
    );
  }

  const created = await db.webhookDelivery.create({
    data: {
      projectId,
      endpointId: original.endpointId,
      agentId: original.endpoint.agentId,
      status: DELIVERY_STATUS.PENDING,
      eventType: original.eventType,
      dedupeKey: null,
      payload: original.payload as Prisma.InputJsonValue,
      headers: original.headers as Prisma.InputJsonValue,
      bodyBytes: original.bodyBytes,
      replayOfId: original.id,
    },
    select: { id: true },
  });

  const rendered = renderTemplate(original.endpoint.template, {
    payload: original.payload,
    rawBody: JSON.stringify(original.payload),
    slug: original.endpoint.slug,
    event: original.eventType,
    deliveryId: created.id,
  });

  await db.webhookDelivery.update({
    where: { id: created.id },
    data: {
      renderedText: rendered.text,
      renderWarnings: rendered.unresolved,
    },
  });

  notifyPending(original.endpoint.agentId);
  return {
    id: created.id,
    replayOfId: original.id,
    endpointId: original.endpointId,
  };
};
