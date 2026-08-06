import { describe, expect, it } from "vitest";

import { clientCertEnrollSchema } from "./client-cert";

const VALID_CSR =
  "-----BEGIN CERTIFICATE REQUEST-----\nMIIBazCB7QIBADAA\n-----END CERTIFICATE REQUEST-----\n";

describe("clientCertEnrollSchema", () => {
  it("accepts a well-formed CSR with no label", () => {
    const result = clientCertEnrollSchema.safeParse({ csrPem: VALID_CSR });
    expect(result.success).toBe(true);
  });

  it("accepts a well-formed CSR with a label", () => {
    const result = clientCertEnrollSchema.safeParse({
      csrPem: VALID_CSR,
      label: "ci-runner-1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a body missing csrPem", () => {
    const result = clientCertEnrollSchema.safeParse({ label: "no-csr" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty csrPem", () => {
    const result = clientCertEnrollSchema.safeParse({ csrPem: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a csrPem that isn't a CERTIFICATE REQUEST PEM", () => {
    const notACsr =
      "-----BEGIN CERTIFICATE-----\nMIIBazCB7QIBADAA\n-----END CERTIFICATE-----\n";
    const result = clientCertEnrollSchema.safeParse({ csrPem: notACsr });
    expect(result.success).toBe(false);
  });

  it("rejects plain garbage as csrPem", () => {
    const result = clientCertEnrollSchema.safeParse({
      csrPem: "not a csr at all",
    });
    expect(result.success).toBe(false);
  });

  // The schema is the enforcement point for "no key material in this
  // request" — `.strict()` means ANY extra field fails validation, not just
  // a specifically-named one, so a client that hands over a key by mistake
  // (whatever it calls the field) gets rejected.
  it.each(["keyPem", "privateKey", "key"])(
    "rejects a body containing a %s field",
    (fieldName) => {
      const result = clientCertEnrollSchema.safeParse({
        csrPem: VALID_CSR,
        [fieldName]:
          "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
      });
      expect(result.success).toBe(false);
    },
  );

  it("rejects an empty label", () => {
    const result = clientCertEnrollSchema.safeParse({
      csrPem: VALID_CSR,
      label: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an oversized label", () => {
    const result = clientCertEnrollSchema.safeParse({
      csrPem: VALID_CSR,
      label: "a".repeat(256),
    });
    expect(result.success).toBe(false);
  });

  // FIX 1 (per-host identity model): hostId is optional (first enrollment
  // omits it) but must be a real uuid when provided (renewal).
  it("accepts a well-formed CSR with a valid hostId", () => {
    const result = clientCertEnrollSchema.safeParse({
      csrPem: VALID_CSR,
      hostId: "11111111-1111-4111-8111-111111111111",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-uuid hostId", () => {
    const result = clientCertEnrollSchema.safeParse({
      csrPem: VALID_CSR,
      hostId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  // A CSR-shaped string (has the PEM marker) at an exact total length, with
  // no leading/trailing whitespace — so `.trim()` (which runs before
  // `.max()` in the chain) is a no-op and doesn't shift the boundary.
  const csrPemOfLength = (totalLength: number) => {
    const header = "-----BEGIN CERTIFICATE REQUEST-----\n";
    const footer = "\n-----END CERTIFICATE REQUEST-----";
    const padLength = totalLength - header.length - footer.length;
    return header + "A".repeat(Math.max(padLength, 0)) + footer;
  };

  // Matches the gateway's MAX_CLIENT_CERT_REQUEST_BODY_BYTES (16KB): an
  // oversized CSR must be rejected HERE, at the Node layer, rather than
  // being forwarded to the gateway only to be capped there.
  it("accepts a csrPem exactly at the 16KB cap", () => {
    const csr = csrPemOfLength(16384);
    expect(csr.length).toBe(16384);
    const result = clientCertEnrollSchema.safeParse({ csrPem: csr });
    expect(result.success).toBe(true);
  });

  it("rejects a csrPem one byte over the 16KB cap", () => {
    const csr = csrPemOfLength(16385);
    expect(csr.length).toBe(16385);
    const result = clientCertEnrollSchema.safeParse({ csrPem: csr });
    expect(result.success).toBe(false);
  });

  it("rejects a wildly oversized csrPem", () => {
    const csr = csrPemOfLength(1_000_000);
    const result = clientCertEnrollSchema.safeParse({ csrPem: csr });
    expect(result.success).toBe(false);
  });
});
