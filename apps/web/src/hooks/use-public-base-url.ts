"use client";

import { API_ORIGIN } from "@/lib/api-fetch";
import { APP_URL, IS_CLOUD } from "@/lib/env";

/**
 * The origin an external sender would use to reach this instance.
 *
 * This matters more here than anywhere else in the app: the string is pasted
 * into GitHub's Payload URL field, so getting it wrong behind a proxy or a
 * tunnel means deliveries that never arrive, with no error anywhere on our
 * side. Same fallback chain as the OAuth redirect-URI field, which has the same
 * "must match what the provider will call" property.
 *
 * `serverValue` is the origin the RSC page resolved (configured APP_URL, else
 * the request's own origin) — always prefer it when present; `window.location`
 * is the last resort for a component that has no server prop, such as a dialog
 * opened from a client-only tree.
 */
export const usePublicBaseUrl = (serverValue?: string): string => {
  if (IS_CLOUD) return API_ORIGIN || APP_URL;
  if (serverValue) return serverValue.replace(/\/+$/, "");
  const configured = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "");
  if (configured) return configured;
  return typeof window !== "undefined" ? window.location.origin : APP_URL;
};
