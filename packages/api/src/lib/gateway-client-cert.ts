/**
 * Outbound call to the gateway's internal client-cert minting endpoint.
 *
 * Direction: Node -> gateway (the opposite of `gateway-invalidate.ts`'s
 * cache-flush calls, which also go Node -> gateway but ride the caller's own
 * session/API-key auth). This one authenticates with the shared
 * `X-Gateway-Secret` instead — mirroring the gateway's own outbound calls to
 * Node's `/v1/internal/onepassword/*` endpoints in
 * `apps/gateway/src/vault/onepassword_api.rs`, just in the other direction
 * and against the gateway's `/v1/internal/client-cert/issue`.
 */
import { GATEWAY_API_URL, GATEWAY_INTERNAL_SECRET } from "./env";
import { ServiceError } from "../services/errors";

export interface MintClientCertParams {
  hostId: string;
  spiffeUri: string;
  csrPem: string;
  lifetimeSecs?: number;
}

export interface MintClientCertResult {
  certPem: string;
  caPem: string;
  serial: string;
  notAfter: number;
}

interface GatewayIssueResponse {
  cert_pem: string;
  ca_pem: string;
  serial_hex: string;
  not_after_unix: number;
}

/**
 * Ask the gateway to mint a client certificate from a CSR. Never sends or
 * receives a private key — the CSR is the client's own proof of possession;
 * the gateway signs over its public key alone (see the `SECURITY` note on
 * `ClientCa::sign_csr` in the gateway).
 *
 * Maps the gateway's 400 (malformed/tampered CSR) to a `ServiceError` the
 * route can translate straight to its own 400; 503 (no minting authority
 * configured) and any other non-2xx become distinct `ServiceError`s so the
 * route doesn't have to inspect status codes itself.
 */
export const mintClientCert = async (
  params: MintClientCertParams,
): Promise<MintClientCertResult> => {
  const response = await fetch(
    `${GATEWAY_API_URL}/v1/internal/client-cert/issue`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gateway-secret": GATEWAY_INTERNAL_SECRET,
      },
      body: JSON.stringify({
        host_id: params.hostId,
        spiffe_uri: params.spiffeUri,
        csr_pem: params.csrPem,
        lifetime_secs: params.lifetimeSecs,
      }),
    },
  ).catch((err) => {
    throw new ServiceError(
      "SERVICE_UNAVAILABLE",
      `gateway client-cert endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  if (response.status === 400) {
    const body = await response.json().catch(() => null);
    const message = (body as { error?: string } | null)?.error ?? "invalid CSR";
    throw new ServiceError("BAD_REQUEST", message);
  }
  if (response.status === 503) {
    throw new ServiceError(
      "SERVICE_UNAVAILABLE",
      "client certificate minting is not available",
    );
  }
  if (!response.ok) {
    throw new ServiceError(
      "SERVICE_UNAVAILABLE",
      `gateway client-cert endpoint returned ${response.status}`,
    );
  }

  const body: GatewayIssueResponse = await response.json();
  return {
    certPem: body.cert_pem,
    caPem: body.ca_pem,
    serial: body.serial_hex,
    notAfter: body.not_after_unix,
  };
};
