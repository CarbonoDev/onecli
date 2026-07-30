import { apiFetch } from "@/lib/api-fetch";

const extractErrorMessage = (body: Record<string, unknown>, status: number) => {
  const err = body.error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err)
    return String((err as { message: unknown }).message);
  return `Request failed: ${status}`;
};

/**
 * A failed API response. Still a plain `Error` (every `err instanceof Error`
 * toast keeps working), plus the HTTP status — a 403 from an admin-only route
 * is an EXPECTED outcome some surfaces render differently from a transport
 * failure, and the message alone cannot tell them apart.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const toApiError = (body: Record<string, unknown>, status: number) =>
  new ApiError(extractErrorMessage(body, status), status);

export const apiGet = async <T>(path: string): Promise<T> => {
  const res = await apiFetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw toApiError(body, res.status);
  }
  return res.json();
};

export const apiPost = async <T>(path: string, body: unknown): Promise<T> => {
  const res = await apiFetch(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw toApiError(data, res.status);
  }
  return res.json();
};

export const apiPatch = async <T>(path: string, body: unknown): Promise<T> => {
  const res = await apiFetch(path, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw toApiError(data, res.status);
  }
  return res.json();
};

export const apiPut = async <T>(path: string, body: unknown): Promise<T> => {
  const res = await apiFetch(path, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw toApiError(data, res.status);
  }
  return res.json();
};

export const apiDelete = async (path: string): Promise<void> => {
  const res = await apiFetch(path, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw toApiError(body, res.status);
  }
};
