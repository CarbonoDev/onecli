# Remote gateway deployment (CarbonoDev fork)

How to host the OneCLI gateway on a different machine than the agents (Dokploy /
Railway), using the mutual-TLS + relay stack (gateway Phases 1–5). This is a
**fork** deployment — images publish to `ghcr.io/carbonodev/onecli`, never the
official `ghcr.io/onecli/onecli`.

## 1. Publish the image

The `relay` subcommand exists only in this fork's build, so remote mode needs a
fork image. The existing `.github/workflows/publish.yml` already targets the
fork's namespace (`IMAGE_NAME: ${{ github.repository }}` → `ghcr.io/carbonodev/onecli`)
and triggers on any `v*` tag — independent of the `release-please` flow on `main`
(which you do NOT run for this).

1. Merge the stacked PRs onto your deployable line (`#2 → #3 → #4`, and `#5` for
   binding enforcement).
2. Set the root `package.json` `version` to a fork-distinct pre-release, e.g.
   `1.44.0-carbono.1` (the pre-release suffix avoids colliding with upstream
   onecli versions, and `docker/metadata-action` then skips the moving `1.44`
   tag).
3. Tag and push:
   ```bash
   git tag v1.44.0-carbono.1
   git push origin v1.44.0-carbono.1
   ```
   The workflow builds multi-arch (amd64 + arm64) from `docker/Dockerfile`
   (an **OSS** `cargo build --release` — the broken `--features cloud` path is
   not used) and pushes `ghcr.io/carbonodev/onecli:1.44.0-carbono.1` + `:latest`.
   The image contains both the web app and `/usr/local/bin/onecli-gateway`
   (which carries the `relay` subcommand).
4. **Make the GHCR package public** (Packages → the image → Package settings →
   Change visibility → Public) so every gateway/relay host can pull without a
   registry credential. (The image embeds no secrets — they're injected at
   runtime via env.)

> ARM note: the workflow's `ubuntu-24.04-arm` matrix leg needs ARM runners
> enabled for the org, or drop that leg.

## 2. Deploy the remote gateway (Dokploy / Railway)

Run the **full** `ghcr.io/carbonodev/onecli:1.44.0-carbono.1` image (web API for
enrollment + container-config, gateway for the mTLS listener).

Required env for the mTLS listener (all off unless `GATEWAY_MTLS_PORT` is set):

| Var | Value |
|-----|-------|
| `GATEWAY_MTLS_PORT` | the mTLS listen port (e.g. `10256`) |
| `GATEWAY_TLS_CERT` / `GATEWAY_TLS_KEY` | the gateway's **server** cert + key (PEM or path) |
| `GATEWAY_CLIENT_CA` | the client CA cert (Phase 2 can also generate one on disk) |
| `GATEWAY_PLAIN_BIND` | **`127.0.0.1`** — see below |
| `GATEWAY_BINDING_ENFORCEMENT` | `off` → `log` → `enforce` (roll out gradually) |

Two deployment requirements that are easy to get wrong:

- **Expose the mTLS port as raw TCP passthrough.** On Railway use a TCP proxy;
  on Dokploy a raw TCP port — NOT the HTTP/L7 router. An L7 proxy terminates TLS
  and the gateway never sees the client certificate, so the handshake fails.
  The web API (`APP_URL`) can stay behind normal HTTPS/L7.
- **Restrict the plaintext listener.** The gateway keeps a plain listener (the
  web app / loopback path) that is *exempt* from cert auth and binding by design.
  If it's network-reachable it's a bypass of everything. Bind it to loopback
  (`GATEWAY_PLAIN_BIND=127.0.0.1`) and don't publish that port. The gateway warns
  at startup if enforcement is on while the plain listener is on a non-loopback
  address.

## 3. Wire nanoclaw (the relay)

nanoclaw's default relay image already points at the fork build
(`ghcr.io/carbonodev/onecli:1.44.0-carbono.1`, kept in sync with `versions.json`
by the pin-drift test). Configure a host for remote mode via `--remote` setup,
which writes:

- `ONECLI_URL` — the remote web API (for the SDK's container-config / approvals).
- `ONECLI_API_KEY` — a **project-scoped** `oc_` key (the relay enrolls with it).
- `NANOCLAW_EGRESS_LOCKDOWN=true` — remote mode requires lockdown (the relay IS
  the egress path); nanoclaw refuses to start remote mode without it.
- `RELAY_GATEWAY_ADDR` — the remote gateway's mTLS `host:port`.
- `RELAY_GATEWAY_SERVER_CA` — the gateway's **server** CA (out-of-band; NOT the
  client CA or MITM CA). Written to a file under `DATA_DIR`.
- `RELAY_GATEWAY_SERVER_NAME` — set when the mTLS cert's CN/SAN differs from the
  TCP-proxy hostname.

The relay then: generates its own keypair + CSR (private key never leaves it),
enrolls for a per-host client cert (`POST /v1/gateway/client-cert`), renews
before expiry, and blind-splices agent traffic to the gateway over mTLS. Each
agent's `aoc_` token passes through untouched, so the gateway still authenticates
the agent.

To publish a new gateway build later, bump both `versions.json`'s
`onecli-gateway` pin and the `ONECLI_GATEWAY_IMAGE` literal in `src/config.ts`
(the drift-guard test fails if they diverge), and tag a new `v*`.

## 4. Binding enforcement rollout

`GATEWAY_BINDING_ENFORCEMENT` on the gateway:

1. `off` (default) — no enforcement, byte-identical to today.
2. `log` — records every would-deny (a relay cert carrying a token for a
   different project) as an audit event, but allows. Watch these to learn your
   real host↔project topology.
3. `enforce` — denies mismatches (403) and fails closed on a lookup error (502).

Binding is **project-scoped**: a relay enrolled for project X may only carry
tokens for agents in project X. If a single host must serve multiple projects,
enroll one relay/cert per project rather than loosening.

## Known follow-ups

- No writer yet for `ClientHost.revokedAt` — the gateway *denies* revoked hosts
  within one 60s cache TTL, but nothing sets the column; add an API/UI action to
  use the soft-revoke lever.
- No live-DB test tier in the gateway crate (the sqlx decode of a non-null
  `revoked_at` isn't exercised end-to-end).
