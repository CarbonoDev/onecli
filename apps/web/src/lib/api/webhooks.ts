import { apiGet, apiPost, apiPatch, apiDelete } from "./client";
import type {
  CreateWebhookInput,
  UpdateWebhookInput,
  WebhookDeliveryDetail,
  WebhookDeliveryPage,
  WebhookDeliveryStatus,
  WebhookEndpoint,
  WebhookEndpointWithSecret,
  WebhookVerifierOption,
} from "./types";

const base = "/v1/hooks";

export interface DeliveryListParams {
  status?: WebhookDeliveryStatus;
  limit?: number;
  cursorCreatedAt?: string;
  cursorId?: string;
}

const query = (params: DeliveryListParams = {}) => {
  const search = new URLSearchParams();
  if (params.status) search.set("status", params.status);
  if (params.limit) search.set("limit", String(params.limit));
  if (params.cursorCreatedAt)
    search.set("cursorCreatedAt", params.cursorCreatedAt);
  if (params.cursorId) search.set("cursorId", params.cursorId);
  const qs = search.toString();
  return qs ? `?${qs}` : "";
};

export const list = () => apiGet<WebhookEndpoint[]>(base);

/** Returns the plaintext secret — the list endpoint deliberately does not. */
export const get = (hookId: string) =>
  apiGet<WebhookEndpointWithSecret>(`${base}/${hookId}`);

export const verifiers = () =>
  apiGet<WebhookVerifierOption[]>(`${base}/verifiers`);

export const create = (input: CreateWebhookInput) =>
  apiPost<WebhookEndpointWithSecret>(base, input);

export const update = (hookId: string, input: UpdateWebhookInput) =>
  apiPatch<WebhookEndpointWithSecret>(`${base}/${hookId}`, input);

export const remove = (hookId: string) => apiDelete(`${base}/${hookId}`);

export const rotateSecret = (hookId: string) =>
  apiPost<{ id: string; slug: string; secret: string | null }>(
    `${base}/${hookId}/rotate-secret`,
    {},
  );

export const deliveries = (hookId: string, params?: DeliveryListParams) =>
  apiGet<WebhookDeliveryPage>(`${base}/${hookId}/deliveries${query(params)}`);

export const delivery = (deliveryId: string) =>
  apiGet<WebhookDeliveryDetail>(`${base}/deliveries/${deliveryId}`);

export const replay = (deliveryId: string) =>
  apiPost<{ id: string; replayOfId: string; endpointId: string }>(
    `${base}/deliveries/${deliveryId}/replay`,
    {},
  );
