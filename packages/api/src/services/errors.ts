export type ServiceErrorCode =
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "UNPROCESSABLE"
  | "CONFLICT"
  | "FORBIDDEN"
  | "GONE"
  // A downstream dependency the request needs is not configured/available —
  // e.g. the gateway has no client-CA minting authority (an operator's
  // externally managed GATEWAY_CLIENT_CA, no matching key). Distinct from
  // BAD_REQUEST: the request itself is fine, retrying it won't help until
  // the deployment is (re)configured.
  | "SERVICE_UNAVAILABLE";

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;

  constructor(code: ServiceErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ServiceError";
  }
}
