import { handle } from "hono/vercel";
import { app } from "@/lib/api/app";

/**
 * A dedicated segment for the one long-polling route in the API.
 *
 * `GET /v1/hooks/pending` parks for up to POLL_MAX_WAIT_SEC (50s) waiting for
 * a delivery. The shared `/v1/[[...route]]` catch-all inherits whatever the
 * platform default duration is — 10-15s on a Vercel-style runtime — which would
 * kill the handler mid-wait. Shadowing the catch-all for this exact path lets
 * the limit be raised here without touching every other `/v1` route.
 *
 * 60 rather than higher: the wait itself is capped at 50s server-side to stay
 * under the smallest idle timeout in front of us (an AWS ALB defaults to 60s),
 * since nothing flows on the wire while a poller is parked.
 *
 * Precedent for splitting a segment out of the catch-all: `v1/auth/session`.
 */
export const maxDuration = 60;
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export const GET = handle(app);
