"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { webhooks } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import type { CreateWebhookInput, UpdateWebhookInput } from "@/lib/api";

export const useWebhooks = () =>
  useQuery({
    queryKey: queryKeys.webhooks.list(),
    queryFn: () => webhooks.list(),
  });

/** The detail read is what carries the secret; the list deliberately does not. */
export const useWebhook = (hookId: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.webhooks.detail(hookId),
    queryFn: () => webhooks.get(hookId),
    enabled: enabled && hookId !== "",
  });

export const useWebhookVerifiers = () =>
  useQuery({
    queryKey: queryKeys.webhooks.verifiers(),
    queryFn: () => webhooks.verifiers(),
    // The registry only changes on deploy.
    staleTime: Infinity,
  });

export const useCreateWebhook = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWebhookInput) => webhooks.create(input),
    onSuccess: (endpoint) => {
      qc.invalidateQueries({ queryKey: queryKeys.webhooks.all() });
      toast.success(`Webhook "${endpoint.name}" created`);
    },
    onError: (err) => toast.error(err.message),
  });
};

export const useUpdateWebhook = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      hookId,
      input,
    }: {
      hookId: string;
      input: UpdateWebhookInput;
    }) => webhooks.update(hookId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.webhooks.all() });
      toast.success("Webhook updated");
    },
    onError: (err) => toast.error(err.message),
  });
};

export const useDeleteWebhook = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (hookId: string) => webhooks.remove(hookId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.webhooks.all() });
      toast.success("Webhook deleted");
    },
    onError: (err) => toast.error(err.message),
  });
};

export const useRotateWebhookSecret = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (hookId: string) => webhooks.rotateSecret(hookId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.webhooks.all() });
      toast.success("Secret rotated — update it at the provider");
    },
    onError: (err) => toast.error(err.message),
  });
};

export const useDeliveryDetail = (deliveryId: string | null) =>
  useQuery({
    queryKey: queryKeys.webhooks.delivery(deliveryId ?? ""),
    queryFn: () => webhooks.delivery(deliveryId as string),
    enabled: deliveryId !== null,
  });

export const useReplayDelivery = (hookId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deliveryId: string) => webhooks.replay(deliveryId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.webhooks.deliveries(hookId) });
      toast.success("Replayed — a new delivery is queued");
    },
    onError: (err) => toast.error(err.message),
  });
};
