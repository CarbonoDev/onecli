import { z } from "zod";

/**
 * Body of `POST /v1/gateway/client-cert`. `.strict()` deliberately — this
 * schema is also the enforcement point for "no key material in the
 * request": any extra field (a `keyPem`, `privateKey`, ...) fails validation
 * outright rather than being silently stripped, so a client that
 * misunderstands the flow (and tries to hand over a key instead of proving
 * possession via CSR) gets a clear 400, not a request that quietly ignores
 * what it sent.
 *
 * `hostId` is optional: omitted on first enrollment (the route mints a new
 * `ClientHost`), provided on renewal (the route reuses that host's existing
 * identity — see `ensureClientHost`, which is also where the tenant-scoped
 * lookup enforcing this lives; this schema only checks the shape).
 */
export const clientCertEnrollSchema = z
  .object({
    csrPem: z
      .string()
      .trim()
      .min(1, "csrPem is required")
      // Matches the gateway's own MAX_CLIENT_CERT_REQUEST_BODY_BYTES (16KB)
      // cap on `POST /v1/internal/client-cert/issue` — a real CSR is a few
      // KB at most, so an oversized one is rejected HERE, at the Node layer,
      // rather than reaching the gateway (and being forwarded/spent effort
      // on) only to be capped there. Keeping the two limits equal means an
      // operator reading either file sees the same number.
      .max(16384, "csrPem must not exceed 16KB")
      .refine(
        (v) => v.includes("-----BEGIN CERTIFICATE REQUEST-----"),
        "csrPem must be a PEM-encoded CERTIFICATE REQUEST",
      ),
    label: z.string().trim().min(1).max(255).optional(),
    hostId: z.string().uuid("hostId must be a valid host id").optional(),
  })
  .strict();

export type ClientCertEnrollInput = z.infer<typeof clientCertEnrollSchema>;
