import { apiGet } from "./client";
import type { SessionInfo } from "./types";

/**
 * `GET /v1/auth/session` — who the caller is, and which org/project the server
 * resolves for them.
 *
 * The `organizationId` override fences the lookup to an org the caller has NOT
 * selected yet: the org switcher uses it to learn where a switch would land
 * before it writes any cookie, so the selection and the project it implies are
 * written together instead of the client guessing which project is that org's
 * default (the server's `findUserDefaultProject` is the only definition, and a
 * second one here would drift).
 */
export const get = (options: { organizationId?: string } = {}) =>
  apiGet<SessionInfo>(
    "/v1/auth/session",
    options.organizationId
      ? { headers: { "X-Organization-Id": options.organizationId } }
      : undefined,
  );
