import { createHash, randomBytes } from "crypto";

/**
 * PKCE (RFC 7636) verifier/challenge pair for OAuth authorization-code flows.
 *
 * Required by public clients — providers that issue no client secret (e.g. the
 * MCP authorization pattern: a dynamically registered client with
 * `token_endpoint_auth_method: "none"`). The challenge travels in the
 * authorization URL; the verifier stays server-side and is replayed at the
 * token exchange, which is what binds the code to this exact flow.
 */
export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** 32 random bytes → 43 base64url chars, the RFC 7636 minimum length. */
export const createPkcePair = (): PkcePair => {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
};
