# Nanoclaw Integration

Integrate OneCLI with [Nanoclaw](https://github.com/nanoclaw/nanoclaw) or any Docker-based agent orchestrator to route agent traffic through the OneCLI gateway — and, optionally, to receive inbound webhook triggers (see [Receiving webhooks](#receiving-webhooks) below).

## Prerequisites

- OneCLI instance running (self-hosted or cloud)
- User API key from the OneCLI dashboard (`oc_...`)

## Install

```bash
npm install @onecli-sh/sdk
```

## Environment Variables

The orchestrator needs two env vars:

| Variable         | Required | Description                                                                     |
| ---------------- | -------- | ------------------------------------------------------------------------------- |
| `ONECLI_API_KEY` | Yes      | User API key from OneCLI dashboard (`oc_...`)                                   |
| `ONECLI_URL`     | No       | OneCLI instance URL. Defaults to `https://app.onecli.sh`                        |
| `ONECLI_HOOKS`   | No       | Set to `1` to also drain the inbound webhook queue. Off by default — see below. |

For self-hosted: `ONECLI_URL=http://localhost:10254`

## Quick Start

```typescript
import { OneCLI } from "@onecli-sh/sdk";

// Reads ONECLI_API_KEY and ONECLI_URL from environment
const onecli = new OneCLI();

const args = ["run", "-i", "--rm", "--name", "my-agent"];
await onecli.applyContainerConfig(args);
// args is now mutated with -e HTTPS_PROXY=..., -v ca.pem:..., etc.
await exec("docker", [...args, "agent-image:latest"]);
```

## Usage

```typescript
import { OneCLI } from "@onecli-sh/sdk";

const onecli = new OneCLI({
  apiKey: process.env.ONECLI_API_KEY, // or omit to read from env
  url: process.env.ONECLI_URL, // omit for cloud (app.onecli.sh)
});

const args = ["run", "-i", "--rm", "--name", "my-agent"];
const active = await onecli.applyContainerConfig(args, {
  combineCaBundle: true, // merge system + OneCLI CAs (default: true)
  addHostMapping: true, // --add-host on Linux (default: true)
});

if (active) {
  console.log("Gateway configured — credentials will be injected");
} else {
  console.log("OneCLI not reachable — running without gateway");
}

await exec("docker", [...args, "agent-image:latest"]);
```

## What the SDK Does

When `applyContainerConfig` succeeds, it mutates the Docker args array with:

1. **Gateway env vars**: `-e HTTPS_PROXY=...`, `-e HTTP_PROXY=...`, `-e NODE_USE_ENV_PROXY=1`
2. **Node.js CA trust**: `-e NODE_EXTRA_CA_CERTS=/tmp/onecli-gateway-ca.pem` + volume mount
3. **System-wide CA trust**: `-e SSL_CERT_FILE=/tmp/onecli-combined-ca.pem` + volume mount (covers curl, Python, Go, git)
4. **Linux host mapping**: `--add-host host.docker.internal:host-gateway` (macOS Docker Desktop provides this automatically)

Traffic from the container goes through the gateway, which injects credentials on matching requests.

## Advanced: Raw Config

If you need the raw config (e.g. for a non-Docker runtime):

```typescript
const config = await onecli.getContainerConfig();
// {
//   env: { HTTPS_PROXY: "...", HTTP_PROXY: "...", NODE_EXTRA_CA_CERTS: "...", NODE_USE_ENV_PROXY: "1" },
//   caCertificate: "-----BEGIN CERTIFICATE-----\n...",
//   caCertificateContainerPath: "/tmp/onecli-gateway-ca.pem"
// }
```

## Nanoclaw-specific Example

In Nanoclaw's container runner, add OneCLI config before spawning the container:

```typescript
import { OneCLI } from "@onecli-sh/sdk";

// Inject OneCLI gateway config (skipped if ONECLI_API_KEY is not set)
const onecliApiKey = process.env.ONECLI_API_KEY;
if (onecliApiKey) {
  const onecli = new OneCLI({
    apiKey: onecliApiKey,
    url: process.env.ONECLI_URL,
  });
  const active = await onecli.applyContainerConfig(args);
  if (active) {
    console.log("OneCLI gateway config applied");
  }
}
```

Users without OneCLI simply don't set `ONECLI_API_KEY`. No code changes needed.

## Receiving webhooks

Everything above is outbound: the orchestrator's traffic goes out through the
gateway. OneCLI can also carry traffic the other way — an external provider
POSTs to OneCLI, and the orchestrator picks the trigger up.

The orchestrator **long-polls** for work, so this adds no listening socket and
no inbound port on the machine it runs on:

```
GitHub ──▶ POST https://<onecli>/v1/hooks/<publicId>
              verify → render template → queue
                          ▲
   orchestrator ──────────┘   GET  /v1/hooks/pending   (outbound, held ~25s)
                              POST /v1/hooks/ack
```

Enable it with `ONECLI_HOOKS=1`. It is **opt-in rather than implied by
`ONECLI_API_KEY`**: today that key means only "route container traffic through
the gateway", and silently adding an inbound message path on a version bump is
not something an operator should discover from their logs.

Each webhook endpoint in OneCLI carries a free-form `routing` JSON object that
OneCLI never parses and hands to the consumer verbatim. Nanoclaw reads:

```json
{ "mode": "lane", "target": { "lane": "triage" } }
{ "mode": "chat", "target": { "channelType": "whatsapp", "platformId": "…" } }
```

When the consumer cannot act on a delivery — an unparseable routing blob, a
chat target that does not exist — it should nack with `retryable: false` and a
reason. The reason is shown in OneCLI's delivery log, so a misconfigured
endpoint is diagnosable from the dashboard without SSH access to the box.

See [docs/webhooks.md](./webhooks.md) for the full consumer contract: auth,
the envelope, ack semantics, backoff guidance, and delivery statuses.
