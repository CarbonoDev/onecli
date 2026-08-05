# Webhooks

Let GitHub, alerting tools, or any HTTP sender trigger an agent — without opening
a port on the machine the agent runs on.

## How it works

```
  GitHub / Datadog / anything that can POST
        │  HTTPS
        ▼
  POST https://<your-onecli>/v1/hooks/<publicId>
┌─────────────────────────────────────────────────────────────┐
│  OneCLI                                                     │
│    verify signature  →  store delivery  →  render template  │
│                                              │              │
│                                        queued for an agent  │
└──────────────────────────────────────────────┬──────────────┘
                                               │
        the agent runtime LONG-POLLS ──────────┘
        GET /v1/hooks/pending          (outbound only)
        POST /v1/hooks/ack
```

The consumer **pulls**. Nothing connects inward to the machine running your
agent, so it needs no public port, no tunnel, and no inbound firewall rule.

A delivery that is queued but never acked comes back automatically when its
lease expires, so a consumer that restarts mid-flight loses nothing.

## Create an endpoint

**Webhooks → Create endpoint.** You choose:

| Field                | What it does                                                                     |
| -------------------- | -------------------------------------------------------------------------------- |
| **Name**             | Display only.                                                                    |
| **Slug**             | Identifies the webhook to the agent; also `{{$slug}}` in templates.              |
| **Verification**     | How a delivery is proven authentic — see below.                                  |
| **Agent to wake**    | Whose queue the delivery lands in. The agent's poller drains only its own queue. |
| **Message template** | The text the agent receives. See [Templates](#templates).                        |
| **Routing**          | An opaque JSON blob passed to your runtime untouched. See [Routing](#routing).   |

On save you get the **payload URL** and the **secret**. Paste both into the
provider. Both stay readable from the endpoint's page afterwards — you will need
the secret again when you reconfigure the provider months from now.

## Ingest URL and verification

The URL is `<APP_URL>/v1/hooks/<publicId>`, where `publicId` is 128 bits of
CSPRNG. Treat the URL itself as sensitive.

> If your instance sits behind a proxy or tunnel, set `APP_URL` (Settings →
> Instance) so the URL shown in the dashboard is the one providers can actually
> reach. This is the single most common setup failure.

Always send `Content-Type: application/json`. (GitHub's form-encoded mode also
works, but every template example here assumes JSON.)

| Verification     | The sender must present                                              | Headers read                                       |
| ---------------- | -------------------------------------------------------------------- | -------------------------------------------------- |
| **GitHub**       | HMAC-SHA256 of the raw body, hex, as `X-Hub-Signature-256: sha256=…` | `X-GitHub-Event`, `X-GitHub-Delivery`              |
| **Shared token** | The secret, in `X-Webhook-Token`, as a bearer token, or as `?token=` | `X-Event-Type`, `X-Delivery-Id`, `Idempotency-Key` |
| **None**         | Nothing — the URL is the only credential                             | same as above                                      |

`None` requires an explicit acknowledgement when creating the endpoint. Anyone
who learns the URL can wake your agent, so keep it out of issues, screenshots
and shared terminals.

The signature is computed over the **exact bytes** received. Re-serializing the
JSON — reordering keys, changing whitespace — invalidates it.

## Templates

The rendered template is what the agent is told. Substitution only; there are no
conditionals, no loops, and nothing is evaluated.

| Placeholder        | Resolves to                                                 |
| ------------------ | ----------------------------------------------------------- |
| `{{a.b.0.c}}`      | A dot path into the payload. Numeric segments index arrays. |
| `{{$raw}}`         | The raw request body (capped at 8 000 characters).          |
| `{{$event}}`       | The provider's event name, e.g. `issues.opened`.            |
| `{{$slug}}`        | The endpoint's slug.                                        |
| `{{$delivery_id}}` | This delivery's id.                                         |

A path that resolves to nothing renders as an empty string and is listed under
**Unresolved placeholders** in the delivery detail — so a typo shows up in the
log rather than silently producing half a message.

Leave the template blank for the default: the slug, the event, and the raw
payload.

Caps: 2 000 characters per substituted value, 16 000 for the whole message.

## Routing

`routing` is a free-form JSON object stored with the endpoint and copied
verbatim into every delivery. **OneCLI never parses it.** It exists so a
consumer can carry its own dispatch semantics without OneCLI needing to know
them.

The reference consumer (nanoclaw) reads:

```json
{ "mode": "lane", "target": { "lane": "triage" } }
{ "mode": "chat", "target": { "channelType": "whatsapp", "platformId": "…" } }
```

That schema belongs to nanoclaw, not to OneCLI. A different runtime is free to
define its own — check its documentation.

## Consuming deliveries

Everything below is what a runtime needs to implement a consumer. There is no
SDK requirement; this is plain HTTP.

### Authenticate

Prefer the **agent access token** (`aoc_…`, shown on the agent's page). It names
exactly one agent, so it is also the queue selector, and a leak drains one
queue rather than exposing the project's secrets.

```
Authorization: Bearer aoc_…
```

A project API key (`oc_…`) also works, but then you must name the agent
explicitly — a project key never implicitly drains "some" queue:

```
GET /v1/hooks/pending?agent=<agent-identifier>
X-Project-Id: <project id>
```

### Long-poll for work

```
GET /v1/hooks/pending?wait=25&max=10&lease=120&poller=host-1
```

| Parameter | Default   | Range             | Meaning                                                                 |
| --------- | --------- | ----------------- | ----------------------------------------------------------------------- |
| `wait`    | 25        | 0–50 s            | How long to hold the connection when the queue is empty.                |
| `max`     | 10        | 1–25              | Batch size.                                                             |
| `lease`   | 120       | 10–300 s          | How long you have to ack before the delivery is handed to someone else. |
| `poller`  | —         | ≤64 chars         | Opaque identity, shown in the delivery log.                             |
| `include` | `payload` | `payload`\|`none` | Whether to send the raw payload.                                        |

Every value is clamped server-side. Always **200**, never 204 — an empty queue
is the same response shape with an empty list:

```jsonc
{
  "claimId": "5f0f…", // null when empty
  "leaseExpiresAt": "2026-08-05T14:32:10Z", // null when empty
  "deliveries": [
    {
      "id": "9c1e…",
      "endpoint": { "id": "…", "slug": "gh-issues", "name": "GitHub issues" },
      "agent": { "id": "…", "identifier": "triage-bot" },
      "event": "issues.opened",
      "text": "opened acme/api#412", // the rendered template
      "routing": { "mode": "lane" }, // verbatim; parse it yourself
      "attempt": 1,
      "receivedAt": "2026-08-05T14:30:02.114Z",
      "dedupeKey": "9f2a1c30-…",
      "replayOfId": null,
      "payload": { "action": "opened" }, // omitted above 64 KB
      "payloadOmitted": false,
    },
  ],
}
```

`wait=50` is the hard ceiling because nothing flows on the wire while a poller
is parked, and load balancers close idle connections (an AWS ALB defaults to
60 s). If your own proxy is stricter, lower `wait` to match.

### Ack

Batch (preferred — a 10-delivery batch should not cost 10 round trips):

```jsonc
POST /v1/hooks/ack
{
  "claimId": "5f0f…",
  "results": [
    { "id": "9c1e…", "status": "ok" },
    { "id": "9c1f…", "status": "error", "error": "lane offline", "retryable": true }
  ]
}
```

Single delivery: `POST /v1/hooks/deliveries/<id>/ack` with
`{ claimId, status, error?, retryable? }`.

**`retryable` is the important field.** `true` (the default) requeues with
backoff — 30 s, 1 m, 2 m, 4 m, capped at 15 m, up to 5 attempts. `false`
terminates the delivery as `failed` immediately: use it when the delivery will
fail identically forever, such as a routing blob your runtime cannot interpret
or a target that does not exist. Failed deliveries stay in the log and remain
replayable once a human fixes the configuration.

Per-delivery outcomes: `delivered`, `requeued`, `failed`, `stale`.

**`stale` means your lease expired and another poller now owns the delivery.**
Discard your result; do not retry the ack. A request where _every_ result is
stale returns **409**.

### Semantics to design for

- **At-least-once.** Ack after you have acted. A crash between the two means
  redelivery — dedupe locally on the delivery `id`.
- **Ordering** is by availability, not strict arrival: a requeued delivery
  sorts behind fresher work rather than blocking the queue.
- **Backoff** on network failure. Also back off on `401` (60 s → 5 m) and keep
  running rather than exiting, so rotating a key heals without a restart.
- **A fast empty response** (a `200` with no deliveries in well under a second)
  means something between you and OneCLI ignored `wait`. Back off, or you will
  hot-loop.

## Delivery statuses

| Status        | Meaning                                                                          | Set by      |
| ------------- | -------------------------------------------------------------------------------- | ----------- |
| **Queued**    | Waiting for a consumer.                                                          | Ingest      |
| **In flight** | Claimed, lease still valid. Derived, not stored.                                 | Claim       |
| **Delivered** | A consumer acked it. _The runtime accepted it — not that the agent acted on it._ | Ack         |
| **Failed**    | Non-retryable nack, or every attempt exhausted. Replayable.                      | Ack / sweep |
| **Rejected**  | Signature verification failed. The payload is not stored.                        | Ingest      |
| **Handshake** | A provider ping (GitHub's `ping`). Recorded, never queued.                       | Ingest      |
| **Ignored**   | Arrived while the endpoint was disabled.                                         | Ingest      |

## Replay

Replaying inserts a **new** delivery rendered with the endpoint's **current**
template, leaving the original as history. That is how you apply a template fix
to an event that already happened. Rejected deliveries cannot be replayed —
their payload was never stored.

## Limits and security

- Body cap 1 MiB; 120 requests/minute per endpoint by default.
- Secrets are encrypted at rest and readable by project members through the
  dashboard.
- Stored headers are allow-listed. `Authorization`, `Cookie` and the signature
  header itself are never written to the log.
- A rejected delivery is recorded without its payload, so an unverified caller
  cannot write arbitrary content into your log.
- `X-Forwarded-*` is used for rate-limit bucketing only, never for authentication.
- Deliveries are pruned automatically: delivered after 7 days, failed after 30,
  rejected after 1.

## Troubleshooting

| Symptom                                              | Cause                                                                             |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| No rows at all                                       | The provider cannot reach your `APP_URL`. Check it from outside your network.     |
| **Rejected** rows                                    | Wrong secret, or the sender re-serializes the body before signing.                |
| Provider shows 404                                   | Wrong URL, or the endpoint was deleted.                                           |
| Rows stay **Queued**                                 | No consumer is polling. Check the runtime is running and its credential is valid. |
| Stuck **In flight**                                  | A consumer died mid-dispatch; the lease will lapse and it will be retried.        |
| **Failed** with `invalid_routing` / `unknown_target` | The consumer could not interpret the routing blob. Fix it and replay.             |
| Message text is half empty                           | Check **Unresolved placeholders** in the delivery detail.                         |

## Not in this version

Provider-native subscription (OneCLI creating the hook for you through a
connected GitHub account), pushing to a consumer-supplied URL, and lease
extension. The URL is registered by hand today.
