//! HTTP gateway server: connection handling, MITM interception, and tunneling.
//!
//! This module owns the `GatewayServer` struct and the core request flow:
//! accept → authenticate → resolve (via [`connect`]) → MITM or tunnel.
//!
//! Axum handles normal HTTP routes (/healthz). CONNECT requests are intercepted
//! before reaching the router via a `tower::service_fn` wrapper, following the
//! official Axum http-proxy example pattern.
//!
//! Sub-modules handle specific stages of the proxy pipeline:
//! - [`forward`]: request forwarding, header filtering, unconnected app interception
//! - [`mitm`]: TLS interception with generated leaf certificates
//! - [`tunnel`]: direct TCP tunneling for non-intercepted domains
//! - [`response`]: pre-built gateway error responses

mod body;
#[cfg(edition_cloud)]
#[path = "ee/response.rs"]
mod ee_response;
mod finalizers;
pub(crate) mod forward;
mod hints;
#[cfg(edition_oss)]
pub(crate) mod hooks;
#[cfg(any(edition_onprem_slim, edition_onprem_full))]
#[path = "ee/onprem/hooks.rs"]
pub(crate) mod hooks;
#[cfg(edition_cloud)]
#[path = "ee/hooks.rs"]
pub(crate) mod hooks;
mod mitm;
// `pub(crate)` so `main` can report at startup whether dashboard links will be
// built from a configured APP_URL or from the fallback.
pub(crate) mod response;
mod transforms;
mod tunnel;
mod websocket;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::{Context, Result};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::Router;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;
use tokio::time::timeout;
use tokio_rustls::{TlsAcceptor, TlsConnector};
use tower::ServiceExt;
use tower_http::cors::CorsLayer;
use tracing::{debug, info, info_span, warn, Instrument};

use crate::approval::{ApprovalDecision, ApprovalStore, APPROVAL_TIMEOUT_SECS};
use crate::auth::AuthUser;
use crate::binding::{self, BindingMode};
use crate::ca::CertificateAuthority;
use crate::cache::CacheStore;
use crate::client_ca::{self, ClientIdentity, MtlsConfig};
use crate::client_ca_authority::{self, ClientCa, SignCsrError};
use crate::connect::{self, AppConnectionResult, ConnectError, PolicyEngine};
use crate::db;
use crate::inject;
use crate::vault;

/// Cap the client TLS handshake on the mTLS listener so a stalled or hostile
/// ClientHello can't hold a connection task (and, in effect, the socket) open
/// indefinitely.
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// Backoff after a recoverable `accept()` error (e.g. EMFILE under fd
/// pressure) before retrying. Both listeners run under the same
/// `tokio::try_join!` in `run()`, so an unhandled error from one accept loop
/// would cancel the other — this keeps a transient error confined to its own
/// listener instead.
const ACCEPT_RETRY_DELAY: Duration = Duration::from_millis(100);

// ── GatewayState ───────────────────────────────────────────────────────

/// Context for a proxied request, resolved at CONNECT time.
/// Wrapped in `Arc` and shared across all requests within a MITM session.
#[derive(Debug, Default)]
pub(crate) struct ProxyContext {
    pub project_id: Option<String>,
    pub organization_id: Option<String>,
    pub agent_id: Option<String>,
    pub agent_name: Option<String>,
    pub agent_identifier: Option<String>,
    pub agent_token: Option<String>,
    /// Identity extracted from the client's mTLS certificate, when the
    /// connection came in on the mTLS listener. Phase 5's `enforce_binding`
    /// is the first to actually compare an identity against the agent
    /// token's tenant — but it does so from the `client_identity` local
    /// variable BEFORE this `ProxyContext` is built (see `handle_connect` /
    /// `handle_http_proxy`), so this field itself is still carried onward
    /// only for a future consumer (e.g. session-level logging inside
    /// `mitm`/`forward`) rather than read anywhere today, hence the lint
    /// allowance below.
    #[allow(dead_code)]
    pub client_identity: Option<Arc<ClientIdentity>>,
}

/// Shared state for the gateway, passed to all request handlers.
#[derive(Clone)]
pub(crate) struct GatewayState {
    pub ca: Arc<CertificateAuthority>,
    /// Standard upstream client — validates TLS certificates.
    pub http_client: reqwest::Client,
    /// No-verify upstream client — skips TLS certificate validation.
    /// Selected for hosts matched by `skip_verify_hosts`.
    pub http_client_no_verify: reqwest::Client,
    /// Hostname patterns for which TLS certificate validation is skipped.
    /// Supports exact match (`internal.corp`) and wildcard prefix (`*.internal.corp`).
    /// Populated from `GATEWAY_SKIP_VERIFY_HOSTS` (comma-separated).
    pub skip_verify_hosts: Arc<Vec<String>>,
    /// Standard upstream connector for the WebSocket leg, which reqwest does
    /// not serve — validates TLS certificates.
    pub ws_connector: TlsConnector,
    /// No-verify WebSocket connector — skips TLS certificate validation.
    /// Selected for hosts matched by `skip_verify_hosts`, exactly as
    /// `http_client_no_verify` is.
    pub ws_connector_no_verify: TlsConnector,
    pub policy_engine: Arc<PolicyEngine>,
    pub cache: Arc<dyn CacheStore>,
    /// Provider-agnostic vault service for credential fetching.
    pub vault_service: Arc<vault::VaultService>,
    /// Manual approval store for held requests.
    pub approval_store: Arc<dyn ApprovalStore>,
    /// The client-certificate minting authority (Phase 2), when the gateway
    /// is trusting its OWN generated client CA (see `main.rs`). `None` when
    /// an operator has configured an externally managed `GATEWAY_CLIENT_CA`
    /// trust anchor instead — minting against an unrelated locally-generated
    /// CA would produce certificates nobody trusts, so `issue_client_cert`
    /// returns 503 rather than silently minting from the wrong CA.
    pub client_ca: Option<Arc<ClientCa>>,
    /// Phase 5 cert↔token tenant binding enforcement posture, read once at
    /// startup from `GATEWAY_BINDING_ENFORCEMENT` (default `Off` — see
    /// `binding::BindingMode`). Consulted by `enforce_binding`.
    pub binding_mode: BindingMode,
}

// ── GatewayServer ───────────────────────────────────────────────────────

pub struct GatewayServer {
    state: GatewayState,
    port: u16,
    /// `None` when `GATEWAY_MTLS_PORT` is unset — the gateway then runs
    /// exactly as it did before mTLS support existed.
    mtls: Option<MtlsConfig>,
    /// Bind address for the plaintext listener. Defaults to `0.0.0.0`
    /// (`GATEWAY_PLAIN_BIND`) — see the warning in `new()` about what
    /// narrowing it costs when mTLS is also enabled.
    plain_bind: IpAddr,
}

/// Build the HTTP client used for upstream requests.
///
/// - Redirects are disabled so 3xx responses are forwarded to the client as-is.
/// - `accept_invalid_certs` skips TLS certificate validation for upstream connections.
fn build_http_client(accept_invalid_certs: bool) -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .danger_accept_invalid_certs(accept_invalid_certs)
        .build()
        .expect("build HTTP client")
}

/// Accepts any server certificate, for the hosts an operator has explicitly
/// exempted from verification.
///
/// This is deliberately the same posture `reqwest`'s `danger_accept_invalid_certs`
/// gives the HTTP path: chain, hostname *and* handshake signature all go
/// unchecked. Parity is the point — an operator who exempts an internal host
/// expects it to work over both protocols, and the appliances that need the
/// exemption at all are exactly the ones with certificates and signature
/// algorithms nothing modern will accept.
#[derive(Debug)]
struct AcceptAnyServerCert;

impl rustls::client::danger::ServerCertVerifier for AcceptAnyServerCert {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    // Both signature paths must be stubbed: rustls calls exactly one depending
    // on the negotiated version, and TLS 1.2 is still reachable here.
    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    /// This list is load-bearing, not decoration: it becomes the ClientHello's
    /// `signature_algorithms`. Return nothing and the server finds no acceptable
    /// scheme and aborts *before sending a certificate* — the verifier above
    /// never runs, and skipping verification manifests as an unexplained
    /// handshake failure.
    ///
    /// Copied from reqwest so the two paths advertise the same thing. It
    /// deliberately includes schemes our own provider cannot verify (SHA-1,
    /// Ed448) — harmless, because nothing here verifies anything, and it is
    /// what lets a legacy appliance find something it can sign with.
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        use rustls::SignatureScheme;
        vec![
            SignatureScheme::RSA_PKCS1_SHA1,
            SignatureScheme::ECDSA_SHA1_Legacy,
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::RSA_PKCS1_SHA384,
            SignatureScheme::ECDSA_NISTP384_SHA384,
            SignatureScheme::RSA_PKCS1_SHA512,
            SignatureScheme::ECDSA_NISTP521_SHA512,
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::RSA_PSS_SHA384,
            SignatureScheme::RSA_PSS_SHA512,
            SignatureScheme::ED25519,
            SignatureScheme::ED448,
        ]
    }
}

/// Build the TLS config used to dial upstream WebSocket servers.
///
/// The sibling of [`build_http_client`], and built the same way for the same
/// reason: the WebSocket leg dials the same upstreams as the HTTP leg, so it
/// has to honor the same verification exemptions. Built once at startup rather
/// than per upgrade — a rustls config is expensive to assemble.
///
/// # Panics
///
/// Requires the process-default [`rustls::crypto::CryptoProvider`] that `main`
/// installs at startup: with both `ring` and `aws_lc_rs` compiled in, rustls
/// cannot choose one itself and `ClientConfig::builder()` panics.
fn build_ws_tls_config(accept_invalid_certs: bool) -> Arc<rustls::ClientConfig> {
    let mut config = if accept_invalid_certs {
        rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAnyServerCert))
            .with_no_client_auth()
    } else {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth()
    };
    // The upstream leg speaks HTTP/1.1 — an upgrade cannot ride h2 here.
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Arc::new(config)
}

/// Parse `GATEWAY_SKIP_VERIFY_HOSTS` into a list of hostname patterns.
///
/// Patterns support:
/// - Exact match: `internal.corp`
/// - Wildcard subdomain prefix: `*.internal.corp`
///
/// Falls back to empty (no hosts skip verification) if the variable is unset.
fn parse_skip_verify_hosts() -> Vec<String> {
    std::env::var("GATEWAY_SKIP_VERIFY_HOSTS")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Parse an already-read `GATEWAY_PLAIN_BIND` value (`None` when the var is
/// unset) into a bind address, defaulting to `0.0.0.0` (unrestricted —
/// today's behavior, unchanged unless the operator opts into narrowing it).
///
/// Fails closed: unset/empty stays the default, but a SET-and-unparseable
/// value (a typo like `127.0.0.q`, or `localhost`, which isn't an IP literal)
/// is an `Err`, not a silent fallback to the wide-open default. This is the
/// one operator knob for restricting the always-open plaintext listener, so
/// silently widening it on a typo would defeat the whole point of the knob.
///
/// No env access — that's `parse_plain_bind`'s job — so this is directly
/// unit-testable, mirroring the `from_parts`/`from_env` split in `client_ca.rs`.
fn parse_plain_bind_value(value: Option<&str>) -> Result<IpAddr> {
    match value {
        None => Ok(IpAddr::V4(Ipv4Addr::UNSPECIFIED)),
        Some(s) if s.trim().is_empty() => Ok(IpAddr::V4(Ipv4Addr::UNSPECIFIED)),
        Some(s) => s
            .trim()
            .parse()
            .with_context(|| format!("GATEWAY_PLAIN_BIND {s:?} is not a valid IP address")),
    }
}

/// Read `GATEWAY_PLAIN_BIND` from the environment and parse it via
/// [`parse_plain_bind_value`].
fn parse_plain_bind() -> Result<IpAddr> {
    parse_plain_bind_value(std::env::var("GATEWAY_PLAIN_BIND").ok().as_deref())
}

/// Whether the plaintext listener's bind address defeats Phase 5 enforcement:
/// true when `binding_mode` is `Enforce` AND `plain_bind` is anything OTHER
/// than loopback. `enforce_binding` exempts the plain listener by design (see
/// its doc comment) — that is only safe when the plain listener itself is
/// unreachable from wherever an attacker sits. Loopback (`127.0.0.0/8` /
/// `::1`, via `IpAddr::is_loopback`) is the only address this crate can prove
/// is host-local from the bind address alone; anything else — including the
/// wildcard `0.0.0.0`/`::` AND a specific-looking but still off-host-reachable
/// address (a pod/cluster IP) — must warn, since both are equally reachable
/// from outside this process for the purpose of skipping the mTLS port
/// entirely. No env access, so this is directly unit-testable.
fn plain_bind_bypasses_binding_enforcement(binding_mode: BindingMode, plain_bind: IpAddr) -> bool {
    matches!(binding_mode, BindingMode::Enforce) && !plain_bind.is_loopback()
}

/// Returns true if `host` matches any pattern in `patterns`.
///
/// - `*.example.com` matches `sub.example.com` but NOT `example.com` itself.
/// - `example.com` matches only `example.com`.
///
/// Patterns are pre-lowercased by `parse_skip_verify_hosts`.
fn host_matches_skip_verify(host: &str, patterns: &[String]) -> bool {
    let host = host.to_lowercase();
    patterns.iter().any(|pattern| {
        if let Some(suffix) = pattern.strip_prefix('*') {
            // "*.example.com" → suffix = ".example.com"
            host.ends_with(suffix) && host.len() > suffix.len()
        } else {
            host == *pattern
        }
    })
}

impl GatewayServer {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        ca: CertificateAuthority,
        port: u16,
        policy_engine: Arc<PolicyEngine>,
        vault_service: Arc<vault::VaultService>,
        cache: Arc<dyn CacheStore>,
        approval_store: Arc<dyn ApprovalStore>,
        mtls: Option<MtlsConfig>,
        client_ca: Option<Arc<ClientCa>>,
        binding_mode: BindingMode,
    ) -> Result<Self> {
        let global_skip = std::env::var("GATEWAY_DANGER_ACCEPT_INVALID_CERTS").is_ok();
        let skip_verify_hosts = Arc::new(parse_skip_verify_hosts());

        if global_skip {
            warn!("GATEWAY_DANGER_ACCEPT_INVALID_CERTS is set: TLS verification disabled for ALL upstream hosts");
        } else if !skip_verify_hosts.is_empty() {
            info!(hosts = ?skip_verify_hosts.as_ref(), "TLS verification disabled for matched hosts (GATEWAY_SKIP_VERIFY_HOSTS)");
        }

        let plain_bind = parse_plain_bind()?;
        if mtls.is_some() && plain_bind.is_unspecified() {
            warn!(
                "GATEWAY_MTLS_PORT is set but the plaintext listener is still bound to \
                 0.0.0.0 — anyone who can reach that port bypasses certificate \
                 authentication entirely. Set GATEWAY_PLAIN_BIND=127.0.0.1 to restrict it, \
                 but note that loopback also breaks Docker-published browser -> gateway \
                 vault/approval/cache calls, which arrive on the plaintext listener."
            );
        }
        // Phase 5: enforcement is only as strong as the listener it applies
        // to. `enforce_binding` exempts the plain listener BY DESIGN (it has
        // no client certificate to bind at all) — but if that listener is
        // reachable from anywhere an attacker can reach, they simply skip the
        // mTLS port and the binding check entirely. Broader than the mTLS
        // warning above (which only fires on the literal unspecified address,
        // 0.0.0.0): ANY non-loopback bind — including a specific, deliberately
        // "reachable" address like a pod/cluster IP — still lets the plain
        // listener see traffic from off-host, so it warns on anything that
        // isn't loopback, not just the wildcard address.
        if plain_bind_bypasses_binding_enforcement(binding_mode, plain_bind) {
            warn!(
                "GATEWAY_BINDING_ENFORCEMENT=enforce is set but the plaintext listener is \
                 bound to a non-loopback address ({plain_bind}) — cert↔token binding is only \
                 checked on the mTLS listener, so anyone who can reach the plaintext port \
                 bypasses it entirely, same as the mTLS bypass warning above. Restrict \
                 GATEWAY_PLAIN_BIND to loopback (127.0.0.1) or another trusted-network-only \
                 address (same tradeoff noted above applies)."
            );
        }

        let state = GatewayState {
            ca: Arc::new(ca),
            http_client: build_http_client(global_skip),
            http_client_no_verify: build_http_client(true),
            skip_verify_hosts,
            ws_connector: TlsConnector::from(build_ws_tls_config(global_skip)),
            ws_connector_no_verify: TlsConnector::from(build_ws_tls_config(true)),
            policy_engine,
            cache,
            vault_service,
            approval_store,
            client_ca,
            binding_mode,
        };

        Ok(Self {
            state,
            port,
            mtls,
            plain_bind,
        })
    }

    /// Build the Axum router for non-CONNECT routes (healthz, vault API,
    /// approvals, org routes, ...). Shared by both listeners — the plaintext
    /// one and, when configured, the mTLS one.
    fn build_router(&self) -> Router {
        // CORS configuration for browser → gateway requests.
        // credentials: true requires explicit headers/methods (not wildcard *).
        let cors_layer = CorsLayer::new()
            .allow_origin(tower_http::cors::AllowOrigin::mirror_request())
            .allow_headers([
                hyper::header::CONTENT_TYPE,
                hyper::header::AUTHORIZATION,
                hyper::header::ACCEPT,
                // Cloud scopes browser → gateway vault calls to the active
                // project via this header; it must be allow-listed or the CORS
                // preflight blocks the request. (OSS never sends it.)
                hyper::header::HeaderName::from_static("x-project-id"),
            ])
            .allow_methods([
                Method::GET,
                Method::POST,
                Method::PUT,
                Method::DELETE,
                Method::OPTIONS,
            ])
            .allow_credentials(true);

        // Build the Axum router for non-CONNECT routes.
        // The fallback returns 400 Bad Request for anything other than defined routes.
        let axum_router = Router::new()
            .route("/healthz", axum::routing::get(healthz))
            .route("/me", axum::routing::get(me))
            // /v1 routes
            .route(
                "/v1/vault/{provider}/pair",
                axum::routing::post(vault::api::vault_pair),
            )
            .route(
                "/v1/vault/{provider}/status",
                axum::routing::get(vault::api::vault_status),
            )
            .route(
                "/v1/vault/{provider}/pair",
                axum::routing::delete(vault::api::vault_disconnect),
            )
            // 1Password value picker (browse vaults → items → fields)
            .route(
                "/v1/vault/onepassword/vaults",
                axum::routing::get(vault::api::vault_op_vaults),
            )
            .route(
                "/v1/vault/onepassword/vaults/{vaultId}/items",
                axum::routing::get(vault::api::vault_op_items),
            )
            .route(
                "/v1/vault/onepassword/items/{vaultId}/{itemId}/fields",
                axum::routing::get(vault::api::vault_op_fields),
            )
            .route(
                "/v1/cache/invalidate",
                axum::routing::post(invalidate_cache),
            )
            .route(
                "/v1/approvals/pending",
                axum::routing::get(get_pending_approvals),
            )
            .route(
                "/v1/approvals/{id}/decision",
                axum::routing::post(submit_approval_decision),
            )
            // Internal (Node -> gateway): mint a client certificate from a
            // CSR Node forwards. Guarded by X-Gateway-Secret, not session/API
            // key auth — see `issue_client_cert`.
            .route(
                "/v1/internal/client-cert/issue",
                axum::routing::post(issue_client_cert),
            )
            // /api legacy routes (backwards compatibility)
            .route(
                "/api/vault/{provider}/pair",
                axum::routing::post(vault::api::vault_pair),
            )
            .route(
                "/api/vault/{provider}/status",
                axum::routing::get(vault::api::vault_status),
            )
            .route(
                "/api/vault/{provider}/pair",
                axum::routing::delete(vault::api::vault_disconnect),
            )
            // 1Password value picker (legacy /api alias)
            .route(
                "/api/vault/onepassword/vaults",
                axum::routing::get(vault::api::vault_op_vaults),
            )
            .route(
                "/api/vault/onepassword/vaults/{vaultId}/items",
                axum::routing::get(vault::api::vault_op_items),
            )
            .route(
                "/api/vault/onepassword/items/{vaultId}/{itemId}/fields",
                axum::routing::get(vault::api::vault_op_fields),
            )
            .route(
                "/api/cache/invalidate",
                axum::routing::post(invalidate_cache),
            )
            .route(
                "/api/approvals/pending",
                axum::routing::get(get_pending_approvals),
            )
            .route(
                "/api/approvals/{id}/decision",
                axum::routing::post(submit_approval_decision),
            )
            .route(
                "/api/internal/client-cert/issue",
                axum::routing::post(issue_client_cert),
            );

        // Org-scoped routes are mounted via an edition-swapped seam
        // (`ee/org_routes.rs` for cloud + onprem, an identity stub for OSS — see
        // `main.rs`), so the org handler never reaches the OSS build.
        crate::org_routes::mount(axum_router)
            .layer(cors_layer)
            .fallback(fallback)
            .with_state(self.state.clone())
    }

    /// Start the gateway's TCP listener(s). Runs forever.
    ///
    /// Always binds the plaintext listener. When mTLS is configured, ALSO
    /// binds the mTLS listener before either accept loop starts — so a bind
    /// failure on either port aborts startup instead of leaving one listener
    /// silently running without the other — then drives both accept loops
    /// concurrently for the life of the process.
    pub async fn run(&self) -> Result<()> {
        let plain_addr = SocketAddr::new(self.plain_bind, self.port);
        let plain_listener = TcpListener::bind(plain_addr)
            .await
            .context("binding plaintext TCP listener")?;
        // Report what we actually bound rather than what we asked for: with
        // `--port 0` the OS assigns the port, and the requested address would
        // report `:0` — leaving no way to discover where the gateway is listening.
        let plain_bound = plain_listener
            .local_addr()
            .context("reading bound plaintext address")?;
        info!(addr = %plain_bound, "listening for plaintext connections");

        let mtls_listener = match &self.mtls {
            Some(mtls) => {
                let mtls_addr = SocketAddr::new(mtls.bind, mtls.port);
                let listener = TcpListener::bind(mtls_addr)
                    .await
                    .context("binding mTLS TCP listener")?;
                let mtls_bound = listener
                    .local_addr()
                    .context("reading bound mTLS address")?;
                info!(addr = %mtls_bound, "listening for mTLS connections");
                Some((listener, TlsAcceptor::from(Arc::clone(&mtls.server_config))))
            }
            None => None,
        };

        let router = self.build_router();
        let plain_loop = accept_loop(
            plain_listener,
            "plaintext",
            router.clone(),
            self.state.clone(),
            None,
        );

        match mtls_listener {
            Some((listener, acceptor)) => {
                let mtls_loop =
                    accept_loop(listener, "mTLS", router, self.state.clone(), Some(acceptor));
                tokio::try_join!(plain_loop, mtls_loop)?;
            }
            None => plain_loop.await?,
        }

        Ok(())
    }
}

/// Accept connections from `listener` forever, spawning a task per connection.
/// `name` labels this listener in logs (`"plaintext"` or `"mTLS"`) so the two
/// concurrent accept loops are distinguishable.
///
/// Stops accepting NEW connections once a shutdown signal arrives (breaking
/// out of the loop below) — in-flight connections are tracked via a shutdown
/// task guard and drained by `main`'s shutdown sequence, not by this loop.
///
/// When `tls` is set, the TLS handshake happens *inside* the spawned task —
/// never in this loop — so one slow or hostile `ClientHello` can only stall
/// its own connection, not every other pending accept.
async fn accept_loop(
    listener: TcpListener,
    name: &'static str,
    router: Router,
    state: GatewayState,
    tls: Option<TlsAcceptor>,
) -> Result<()> {
    let mut shutdown_signal = crate::shutdown::subscribe();

    loop {
        let (stream, peer_addr) = tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok(pair) => pair,
                Err(e) => {
                    // Log-and-continue: a recoverable accept() error (EMFILE
                    // under fd pressure, ECONNABORTED from a client that gave
                    // up mid-handshake) must not propagate. Both listeners'
                    // loops are driven by the same `tokio::try_join!` in
                    // `run()`, so an `Err` here would cancel the OTHER loop
                    // too, taking down a perfectly healthy listener over a
                    // transient blip on this one.
                    warn!(listener = name, error = %e, "accept() failed, retrying");
                    tokio::time::sleep(ACCEPT_RETRY_DELAY).await;
                    continue;
                }
            },
            _ = shutdown_signal.wait() => break,
        };

        let state = state.clone();
        let router = router.clone();
        let tls = tls.clone();
        let guard = crate::shutdown::task_guard();

        tokio::spawn(async move {
            let _guard = guard;
            match tls {
                Some(acceptor) => {
                    let handshake: Result<_, anyhow::Error> = async {
                        let tls_stream =
                            timeout(TLS_HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await??;
                        Ok(tls_stream)
                    }
                    .await;

                    let tls_stream = match handshake {
                        Ok(s) => s,
                        Err(e) => {
                            warn!(peer = %peer_addr, error = ?e, "mTLS handshake rejected");
                            return;
                        }
                    };

                    // Read the peer's certificate chain before moving the
                    // stream into `TokioIo` — `peer_certificates()` is only
                    // reachable through the raw rustls connection.
                    let client_identity = tls_stream
                        .get_ref()
                        .1
                        .peer_certificates()
                        .and_then(client_ca::identity_from_peer_certs)
                        .map(Arc::new);

                    if let Err(e) = handle_connection(
                        tls_stream,
                        peer_addr,
                        state,
                        router,
                        client_identity,
                        // `on_mtls` is threaded as its OWN signal, separate
                        // from `client_identity` — an mTLS handshake whose
                        // cert had an unparseable CN/SAN also yields `None`
                        // above, and Phase 5's `enforce_binding` must still
                        // see "this came in on the mTLS listener" for that
                        // case (see `binding.rs`'s module doc, subtlety #1).
                        true,
                    )
                    .await
                    {
                        warn!(peer = %peer_addr, error = ?e, "connection error");
                    }
                }
                None => {
                    if let Err(e) =
                        handle_connection(stream, peer_addr, state, router, None, false).await
                    {
                        warn!(peer = %peer_addr, error = ?e, "connection error");
                    }
                }
            }
        });
    }

    // Closing the port is what stops new work: anything that connects from
    // here on is refused rather than accepted into a process on its way out.
    // Dropped explicitly rather than at the end of the scope so the port is
    // provably shut before the line below claims it is.
    drop(listener);
    info!(listener = name, "listener closed — draining connections");
    Ok(())
}

// ── Axum route handlers ─────────────────────────────────────────────────

async fn healthz() -> axum::Json<serde_json::Value> {
    axum::Json(serde_json::json!({
        "status": "ok",
        "version": crate::version::app_version(),
    }))
}

/// Protected: returns the authenticated user's ID.
async fn me(auth: AuthUser) -> String {
    auth.user_id
}

/// Invalidate all cached CONNECT responses for the authenticated project.
/// Called by the web app after secret/rule mutations so agents pick up
/// changes immediately instead of waiting for the 60-second TTL.
async fn invalidate_cache(
    auth: AuthUser,
    State(state): State<GatewayState>,
) -> impl axum::response::IntoResponse {
    let span = info_span!("cache_invalidate",
        project_id = %auth.project_id,
        user_id = %auth.user_id,
        auth_method = %auth.auth_method,
    );
    async move {
        let org_id =
            match db::find_organization_id_by_project(&state.policy_engine.pool, &auth.project_id)
                .await
            {
                Ok(Some(oid)) => oid,
                other => {
                    warn!(
                        error = ?other.err(),
                        "cache invalidation: failed to resolve org_id; using broad prefix"
                    );
                    String::new()
                }
            };

        state
            .cache
            .del_by_prefix(&format!("app_injection:{org_id}:{}:", auth.project_id))
            .await;
        state
            .cache
            .del_by_prefix(&format!("connect:{org_id}:{}:", auth.project_id))
            .await;
        info!("cache invalidated");
        (
            StatusCode::OK,
            axum::Json(serde_json::json!({ "invalidated": true })),
        )
    }
    .instrument(span)
    .await
}

// ── Internal (Node -> gateway): client-certificate minting ──────────────

/// Hard cap on the `POST /v1/internal/client-cert/issue` request body — a
/// CSR (plus `host_id`/`spiffe_uri`/`lifetime_secs`) is a few KB at most even
/// generously padded, nowhere near axum's much larger generic default body
/// limit. Checked explicitly in `issue_client_cert` before the body is
/// parsed.
const MAX_CLIENT_CERT_REQUEST_BODY_BYTES: usize = 16 * 1024;

/// Shared secret the internal gateway<->Node endpoints authenticate with,
/// presented as the `X-Gateway-Secret` header. Read once. Mirrors
/// `vault/onepassword_api.rs`'s outbound `internal_secret()` (same env var,
/// opposite direction — this module CHECKS a value Node presents TO the
/// gateway, rather than presenting one).
fn internal_secret() -> &'static str {
    static SECRET: OnceLock<String> = OnceLock::new();
    SECRET.get_or_init(|| std::env::var("GATEWAY_INTERNAL_SECRET").unwrap_or_default())
}

/// Constant-time byte comparison (no data-dependent early exit once lengths
/// match — only the accumulated OR of differences is inspected at the end).
/// `ring::constant_time::verify_slices_are_equal` is deprecated upstream
/// ("internal function, no side-channel promises"), so this is hand-rolled
/// rather than built on it — the same approach Node's `timingSafeEqual`
/// implements, mirrored here for the Rust side of this shared-secret check.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Comparison against an explicit expected value, fail-closed when that
/// value is empty. Mirrors `packages/api/src/middleware/internal-auth.ts`:
/// an empty configured secret must reject EVERY caller (including one
/// presenting an empty header) rather than "matching" on emptiness — an
/// unconfigured secret is a misconfiguration, never an open door.
///
/// Split from `verify_internal_secret` (which reads the process-wide
/// `OnceLock`-cached env var) purely so this fail-closed logic is directly
/// unit-testable: `internal_secret()`'s cached value can only ever be set
/// once per test binary, which makes it unsuitable for exercising multiple
/// expected-secret scenarios from within the same process.
fn verify_secret(provided: &str, expected: &str) -> bool {
    !expected.is_empty() && constant_time_eq(provided.as_bytes(), expected.as_bytes())
}

/// Comparison against the configured secret — see `verify_secret` for the
/// fail-closed rule this enforces.
fn verify_internal_secret(provided: &str) -> bool {
    verify_secret(provided, internal_secret())
}

/// Body of `POST /v1/internal/client-cert/issue`. `lifetime_secs` is
/// optional — [`client_ca_authority::clamp_lifetime`] supplies the default
/// (24h) and ceiling (7d).
#[derive(serde::Deserialize)]
struct IssueClientCertRequest {
    host_id: String,
    spiffe_uri: String,
    csr_pem: String,
    #[serde(default)]
    lifetime_secs: Option<u64>,
}

#[derive(serde::Serialize)]
struct IssueClientCertResponse {
    cert_pem: String,
    ca_pem: String,
    serial_hex: String,
    not_after_unix: i64,
}

/// `POST /v1/internal/client-cert/issue` (+ `/api` alias): mints a client
/// certificate for `host_id`/`spiffe_uri` from a CSR Node forwards on an
/// agent's behalf.
///
/// Guarded by a shared secret (`X-Gateway-Secret`), NOT the session/API-key
/// `AuthUser` extractor every other route in this file uses — Node is the
/// only caller, and it has already authenticated the human/agent requesting
/// enrollment before it ever calls here. The secret is checked BEFORE the
/// body is parsed (raw `Bytes`, not an `axum::Json` extractor) so an
/// unauthorized caller always gets 401 regardless of what it sent as a body
/// — never a 400 that leaks "the body shape was wrong" to someone who
/// doesn't hold the shared secret.
///
/// `sign_csr` re-parses and re-verifies the CSR itself — Node's own
/// well-formedness check (if any) is never trusted as the security boundary;
/// this endpoint is that boundary.
async fn issue_client_cert(
    State(state): State<GatewayState>,
    headers: hyper::HeaderMap,
    body: axum::body::Bytes,
) -> impl axum::response::IntoResponse {
    let provided = headers
        .get("x-gateway-secret")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !verify_internal_secret(provided) {
        return (
            StatusCode::UNAUTHORIZED,
            axum::Json(serde_json::json!({ "error": "unauthorized" })),
        )
            .into_response();
    }

    // Explicit, tight cap ahead of axum's own (much larger) default body
    // limit: a CSR — even a generously padded one, e.g. an RSA-4096 key with
    // extra attributes — is a few KB at most. Reject anything wildly outside
    // that BEFORE spending effort on it, rather than relying solely on
    // axum's generic default limit (which exists for arbitrary request
    // bodies, not this specifically small shape).
    if body.len() > MAX_CLIENT_CERT_REQUEST_BODY_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            axum::Json(serde_json::json!({ "error": "request body too large" })),
        )
            .into_response();
    }

    let Some(client_ca) = state.client_ca.as_ref() else {
        warn!("client-cert mint requested but no client-CA minting authority is configured");
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(
                serde_json::json!({ "error": "client certificate minting is not available" }),
            ),
        )
            .into_response();
    };

    let req: IssueClientCertRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({ "error": format!("invalid request body: {e}") })),
            )
                .into_response();
        }
    };

    let lifetime = client_ca_authority::clamp_lifetime(req.lifetime_secs);

    match client_ca.sign_csr(&req.host_id, &req.spiffe_uri, &req.csr_pem, lifetime) {
        Ok(issued) => (
            StatusCode::OK,
            axum::Json(IssueClientCertResponse {
                cert_pem: issued.cert_pem,
                ca_pem: client_ca.ca_cert_pem(),
                serial_hex: issued.serial_hex,
                not_after_unix: issued.not_after_unix,
            }),
        )
            .into_response(),
        Err(SignCsrError::BadCsr(msg)) => (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({ "error": format!("invalid CSR: {msg}") })),
        )
            .into_response(),
        Err(SignCsrError::Sign(err)) => {
            warn!(error = ?err, "client-cert signing failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({ "error": "signing failed" })),
            )
                .into_response()
        }
    }
}

/// Query parameters for the pending approvals endpoint.
/// `pub(crate)` so the org route in `org_routes` can reuse the same shape.
#[derive(serde::Deserialize)]
pub(crate) struct PendingParams {
    /// Comma-separated approval IDs to exclude (already being processed by the SDK).
    /// Allows the server to enter long-poll when all pending approvals are in-flight.
    #[serde(default)]
    pub(crate) exclude: String,
}

/// Long-poll for pending manual approval requests.
/// Returns immediately if new (non-excluded) approvals exist, otherwise waits up to 30s.
async fn get_pending_approvals(
    auth: AuthUser,
    State(state): State<GatewayState>,
    axum::extract::Query(params): axum::extract::Query<PendingParams>,
) -> impl axum::response::IntoResponse {
    let span = info_span!("approval_poll",
        project_id = %auth.project_id,
        user_id = %auth.user_id,
        auth_method = %auth.auth_method,
    );
    async move {
        let org_id = db::find_organization_id_by_project(&state.policy_engine.pool, &auth.project_id)
            .await
            .ok()
            .flatten()
            .unwrap_or_default();

        let exclude: std::collections::HashSet<&str> = params
            .exclude
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect();

        info!(exclude_count = exclude.len(), "approval poll started");

        let mut pending = state.approval_store.list_pending(&org_id, &auth.project_id).await;
        pending.retain(|a| !exclude.contains(a.id.as_str()));

        let mut long_polled = false;
        if pending.is_empty() {
            long_polled = true;
            let mut shutdown_signal = crate::shutdown::subscribe();
            // A poller holding a connection open for 30 seconds would pin the
            // drain for its whole window. Answer "nothing pending" at once and
            // let the SDK re-poll against the replacement instance.
            let got_new = tokio::select! {
                got_new = state.approval_store.wait_for_new(
                    &org_id,
                    &auth.project_id,
                    std::time::Duration::from_secs(30),
                ) => got_new,
                _ = shutdown_signal.wait() => false,
            };
            if got_new {
                let mut fresh = state.approval_store.list_pending(&org_id, &auth.project_id).await;
                fresh.retain(|a| !exclude.contains(a.id.as_str()));
                pending = fresh;
            }
        }

        info!(count = pending.len(), long_polled, "approval poll completed");

        axum::Json(serde_json::json!({
            "requests": pending.iter().map(|a| serde_json::json!({
                "id": a.id,
                "projectId": a.project_id,
                "method": a.method,
                "url": format!("{}://{}{}", a.scheme, a.host, a.path),
                "host": a.host,
                "path": a.path,
                "headers": a.headers,
                "bodyPreview": a.body_preview,
                "summary": a.summary,
                "agent": { "id": a.agent_id, "name": a.agent_name, "externalId": a.agent_identifier },
                "createdAt": format_unix_ts(a.created_at),
                "expiresAt": format_unix_ts(a.expires_at),
            })).collect::<Vec<_>>(),
            "timeoutSeconds": APPROVAL_TIMEOUT_SECS,
        }))
    }
    .instrument(span)
    .await
}

/// Submit a decision for a pending manual approval request.
async fn submit_approval_decision(
    auth: AuthUser,
    State(state): State<GatewayState>,
    axum::extract::Path(approval_id): axum::extract::Path<String>,
    axum::Json(body): axum::Json<DecisionBody>,
) -> impl axum::response::IntoResponse {
    let span = info_span!("approval_decision",
        project_id = %auth.project_id,
        user_id = %auth.user_id,
        auth_method = %auth.auth_method,
        approval_id = %approval_id,
    );
    async move {
        let org_id =
            db::find_organization_id_by_project(&state.policy_engine.pool, &auth.project_id)
                .await
                .ok()
                .flatten()
                .unwrap_or_default();

        // O(1) lookup — verify approval exists and belongs to this project.
        match state
            .approval_store
            .get_pending(&org_id, &auth.project_id, &approval_id)
            .await
        {
            Some(a) if a.project_id == auth.project_id => {}
            _ => {
                warn!("approval decision rejected: not found or wrong project");
                return (
                    StatusCode::NOT_FOUND,
                    axum::Json(serde_json::json!({ "error": "approval_not_found" })),
                );
            }
        }

        let decision_str = match body.decision {
            ApprovalDecision::Approve => "approve",
            ApprovalDecision::Deny => "deny",
        };

        info!(decision = decision_str, "approval decision submitted");

        let delivered = state
            .approval_store
            .submit_decision(
                &org_id,
                &auth.project_id,
                &approval_id,
                body.decision,
                Some(auth.user_id),
            )
            .await;

        if delivered {
            (
                StatusCode::OK,
                axum::Json(serde_json::json!({ "success": true })),
            )
        } else {
            warn!(
                decision = decision_str,
                "approval decision submitted but approval already expired"
            );
            (
                StatusCode::GONE,
                axum::Json(serde_json::json!({ "error": "approval_expired" })),
            )
        }
    }
    .instrument(span)
    .await
}

/// Request body for the approval decision endpoint.
/// Deserializes directly into the enum — Axum returns 422 on invalid values.
#[derive(serde::Deserialize)]
struct DecisionBody {
    decision: ApprovalDecision,
}

/// Reject non-proxy, non-CONNECT requests to unknown routes with 400 Bad Request.
async fn fallback() -> StatusCode {
    StatusCode::BAD_REQUEST
}

/// An HTTP proxy request has an absolute URI with `http://` or `https://`
/// scheme (RFC 7230 §5.3.2). Direct requests use origin-form (`/path`).
/// Also matches `https://` because some clients (axios v1.x) send absolute-form
/// HTTPS URIs to the proxy port instead of using CONNECT.
fn is_http_proxy_request<T>(req: &Request<T>) -> bool {
    matches!(req.uri().scheme_str(), Some("http" | "https"))
}

// ── Connection handling ─────────────────────────────────────────────────

/// Handle a single client connection.
///
/// Uses a `service_fn` wrapper that intercepts CONNECT requests before they reach
/// the Axum router (CONNECT URIs like `host:port` don't match Axum's path-based routing).
/// All other HTTP routes (vault API, healthz, etc.) go through the Axum router.
async fn handle_connection<S>(
    stream: S,
    peer_addr: SocketAddr,
    state: GatewayState,
    router: Router,
    client_identity: Option<Arc<ClientIdentity>>,
    // Whether this connection came in on the mTLS listener — set by
    // `accept_loop` from whether `tls` was `Some`, threaded here as its OWN
    // signal rather than inferred from `client_identity.is_some()`. Phase 5's
    // `enforce_binding` needs to tell "mTLS handshake, cert had no usable
    // identity" (deny) apart from "plain listener, no cert at all" (exempt) —
    // both look identical as `client_identity: None` otherwise.
    on_mtls: bool,
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let io = TokioIo::new(stream);

    let conn = http1::Builder::new()
        .preserve_header_case(true)
        .title_case_headers(true)
        .serve_connection(
            io,
            service_fn(move |req: Request<Incoming>| {
                let state = state.clone();
                let router = router.clone();
                let client_identity = client_identity.clone();
                async move {
                    if req.method() == Method::CONNECT {
                        handle_connect(req, peer_addr, state, client_identity, on_mtls).await
                    } else if is_http_proxy_request(&req) {
                        handle_http_proxy(req, peer_addr, state, client_identity, on_mtls).await
                    } else {
                        // Axum handles all non-proxy routes (healthz, vault API, fallback)
                        let resp: Response<axum::body::Body> = router
                            .oneshot(req)
                            .await
                            .expect("axum router is infallible");
                        Ok(resp)
                    }
                }
            }),
        )
        .with_upgrades();
    tokio::pin!(conn);

    let mut shutdown_signal = crate::shutdown::subscribe();

    // One select, no loop: the signal is monotonic, so once it fires there is
    // nothing left to race against. `graceful_shutdown` turns off keep-alive —
    // an idle connection closes at once, an in-flight request still gets its
    // response, and a CONNECT that has already upgraded is unaffected (its
    // session runs in its own task, under its own guard).
    tokio::select! {
        result = conn.as_mut() => result.context("serving HTTP connection"),
        _ = shutdown_signal.wait() => {
            conn.as_mut().graceful_shutdown();
            conn.await.context("draining HTTP connection")
        }
    }
}

// ── Phase 5: cert↔token tenant binding enforcement ──────────────────────

/// Cache TTL for host-tenant lookups — the same 60s window `connect::resolve`
/// uses for `ConnectResponse`, so a revoked/renamed `client_hosts` row is
/// picked up on the same staleness budget as everything else CONNECT-time
/// resolution already accepts.
const BINDING_CACHE_TTL_SECS: u64 = 60;

/// Resolve the `client_hosts` row for `spiffe` via the cache, falling back to
/// `db::find_client_host_by_spiffe` on a miss — mirroring
/// `connect::resolve`'s cache-then-DB pattern. Negative results (no matching
/// row) are cached too, exactly like a positive one: `Option<ClientHostRow>`
/// round-trips through the cache either way, so an attacker hammering an
/// unknown spiffe URI doesn't turn into a sustained DB query per request.
///
/// Returns `Err(())` — collapsing whatever the underlying error was — when
/// the lookup itself failed (DB or cache-deserialization trouble); the
/// caller (`enforce_binding`) fails closed on that, and `binding::evaluate`
/// never needs to know anything about the failure beyond "it happened".
async fn resolve_host_tenant(
    state: &GatewayState,
    spiffe: &str,
) -> Result<Option<db::ClientHostRow>, ()> {
    let cache_key = format!("binding:host:{spiffe}");

    if let Some(cached) = state
        .cache
        .get::<Option<db::ClientHostRow>>(&cache_key)
        .await
    {
        return Ok(cached);
    }

    match db::find_client_host_by_spiffe(&state.policy_engine.pool, spiffe).await {
        Ok(row) => {
            state
                .cache
                .set(&cache_key, &row, BINDING_CACHE_TTL_SECS)
                .await;
            Ok(row)
        }
        Err(e) => {
            warn!(spiffe = %spiffe, error = ?e, "binding: client_hosts lookup failed");
            Err(())
        }
    }
}

/// Phase 5 enforcement gate — the ONE place `handle_connect` and
/// `handle_http_proxy` both call into, so the two entry points can never
/// diverge on what "permitted" means (see the module-level worry this whole
/// feature exists to close: a relay's cert bypassing enforcement on one path
/// while the other still checks it). Returns `Some(response)` to
/// short-circuit the request with a denial, `None` to let it proceed.
///
/// `mode == Off` or `!on_mtls` (the plain listener is exempt BY LISTENER
/// KIND, in every mode — see `binding.rs`'s module doc) both return `None`
/// WITHOUT ever resolving the host tenant: zero DB/cache overhead beyond the
/// mode/on_mtls check itself, so a default (unset) deployment pays nothing
/// for this feature's existence.
async fn enforce_binding(
    state: &GatewayState,
    on_mtls: bool,
    client_identity: Option<&Arc<ClientIdentity>>,
    agent_id: Option<&str>,
    token_project: &str,
    token_org: Option<&str>,
) -> Option<Response<axum::body::Body>> {
    if matches!(state.binding_mode, BindingMode::Off) || !on_mtls {
        return None;
    }

    let identity = client_identity.and_then(|id| id.primary());

    // Only resolve the host tenant when there's an identity to look up at
    // all — `binding::evaluate` denies a missing identity before it ever
    // looks at this result, so an unparseable-cert request never touches the
    // cache or DB.
    let host_lookup: Option<Result<Option<db::ClientHostRow>, ()>> = match identity {
        Some(spiffe) => Some(resolve_host_tenant(state, spiffe).await),
        None => None,
    };
    let host_tenant: Result<Option<&db::ClientHostRow>, ()> = match &host_lookup {
        Some(Ok(row)) => Ok(row.as_ref()),
        Some(Err(())) => Err(()),
        None => Ok(None),
    };
    let host_project_id = match &host_lookup {
        Some(Ok(Some(row))) => Some(row.project_id.as_str()),
        _ => None,
    };

    let decision = binding::evaluate(
        state.binding_mode,
        on_mtls,
        identity,
        host_tenant,
        token_project,
        token_org,
    );

    match decision {
        binding::BindingDecision::Allow => None,
        binding::BindingDecision::WouldDeny { reason } => {
            // Log-mode audit trail: this is what `Enforce` WOULD have denied.
            // Never logs the token or any secret — spiffe/host/token ids only.
            warn!(
                spiffe = identity.unwrap_or("-"),
                host_project_id = host_project_id.unwrap_or("-"),
                token_project_id = %token_project,
                token_org_id = token_org.unwrap_or("-"),
                agent_id = agent_id.unwrap_or("-"),
                reason,
                mode = ?state.binding_mode,
                on_mtls,
                decision = "would_deny",
                "binding: cert/token tenant mismatch (log mode — request allowed)"
            );
            None
        }
        binding::BindingDecision::Deny { reason } => {
            warn!(
                spiffe = identity.unwrap_or("-"),
                host_project_id = host_project_id.unwrap_or("-"),
                token_project_id = %token_project,
                token_org_id = token_org.unwrap_or("-"),
                agent_id = agent_id.unwrap_or("-"),
                reason,
                mode = ?state.binding_mode,
                on_mtls,
                decision = "deny",
                "binding: cert/token tenant mismatch — request denied"
            );
            // The lookup-failed case is retryable (a transient DB/cache
            // hiccup, not a permanent verdict about this identity) — 502,
            // same as every other internal-error path in this file. Every
            // other reason (mismatch, unknown/revoked host, missing
            // identity) is a permanent denial — 403.
            if reason == binding::REASON_HOST_LOOKUP_ERROR {
                Some(response::bad_gateway())
            } else {
                Some(response::binding_denied())
            }
        }
    }
}

// ── CONNECT handling ────────────────────────────────────────────────────

/// Handle a CONNECT request: authenticate, resolve policy, then MITM or tunnel.
async fn handle_connect(
    req: Request<Incoming>,
    peer_addr: SocketAddr,
    state: GatewayState,
    client_identity: Option<Arc<ClientIdentity>>,
    on_mtls: bool,
) -> Result<Response<axum::body::Body>, anyhow::Error> {
    let host = req
        .uri()
        .authority()
        .context("CONNECT request missing host:port")?
        .to_string();

    let hostname = strip_port(&host).to_string();

    // Extract agent token from Proxy-Authorization header.
    let agent_token = inject::extract_agent_token(&req).filter(|t| !t.is_empty());

    // Resolve at CONNECT time for the intercept decision and agent identity.
    // DB injection/policy rules are NOT frozen here — they're re-resolved
    // per request inside the MITM tunnel from cache (see mitm.rs).
    let (mut intercept, project_id, organization_id, agent_id, agent_name, agent_identifier) =
        if let Some(ref token) = agent_token {
            match connect::resolve(token, &hostname, &state.policy_engine, &*state.cache).await {
                Ok(resp) => (
                    resp.intercept,
                    resp.project_id,
                    resp.organization_id,
                    resp.agent_id,
                    resp.agent_name,
                    resp.agent_identifier,
                ),
                Err(ConnectError::InvalidToken) => {
                    warn!(peer = %peer_addr, host = %host, "CONNECT rejected: invalid agent token");
                    return Ok(response::proxy_auth_required());
                }
                Err(ConnectError::Internal(e)) => {
                    warn!(peer = %peer_addr, host = %host, error = %e, "CONNECT rejected: internal error");
                    return Ok(response::bad_gateway());
                }
            }
        } else {
            (false, None, None, None, None, None)
        };

    // Phase 5: cert↔token tenant binding. AFTER `connect::resolve` (needs the
    // token's project/org), BEFORE vault/intercept/spawn — a denial here must
    // short-circuit before any of that runs. Only when an agent token is
    // actually present: no token, nothing to bind.
    if agent_token.is_some() {
        // `connect::resolve`'s success arm always sets `project_id` for a
        // resolved token (`ConnectResponse { project_id: Some(agent.project_id), .. }`);
        // the empty-string fallback only guards a resolver invariant this
        // handler doesn't otherwise depend on.
        let token_project = project_id.as_deref().unwrap_or_default();
        if let Some(denial) = enforce_binding(
            &state,
            on_mtls,
            client_identity.as_ref(),
            agent_id.as_deref(),
            token_project,
            organization_id.as_deref(),
        )
        .await
        {
            return Ok(denial);
        }
    }

    // Vault fallback: resolved at CONNECT time and passed to mitm as a frozen
    // fallback. Vault queries are expensive (network calls to Bitwarden), so
    // they're not repeated per request. DB secrets (re-resolved per request
    // from cache) take precedence when available.
    let mut vault_injection_rules = vec![];
    if !intercept {
        if let Some(ref aid) = project_id {
            if let Some(cred) = state.vault_service.request_credential(aid, &hostname).await {
                let vault_rules = inject::vault_credential_to_rules(&hostname, &cred);
                if !vault_rules.is_empty() {
                    intercept = true;
                    vault_injection_rules = vault_rules;
                    info!(
                        host = %hostname,
                        project_id = %aid,
                        "using vault credential"
                    );
                }
            }
        }
    }

    // Force MITM for all authenticated agent requests so the gateway can
    // intercept auth errors (401/403/400) and provide actionable guidance
    // (credential_not_found, app_not_connected, access_restricted).
    if !intercept && agent_token.is_some() {
        intercept = true;
    }

    let session_span = info_span!("session",
        peer = %peer_addr,
        host = %host,
        project_id = project_id.as_deref().unwrap_or("-"),
        org_id = organization_id.as_deref().unwrap_or("-"),
        agent = agent_name.as_deref().unwrap_or("-"),
        agent_id = agent_id.as_deref().unwrap_or("-"),
        client_identity = client_identity.as_deref().and_then(ClientIdentity::primary).unwrap_or("-"),
    );

    info!(
        parent: &session_span,
        mode = if intercept { "mitm" } else { "tunnel" },
        "CONNECT"
    );

    let ca = Arc::clone(&state.ca);
    let skip_verify = host_matches_skip_verify(&hostname, &state.skip_verify_hosts);
    // Both legs picked in one branch, deliberately: HTTP and WebSocket dial the
    // same upstreams, so a host they disagree about would mean traffic verified
    // on one protocol and not the other. One branch makes that unrepresentable
    // rather than merely true today.
    let (http_client, ws_connector) = if skip_verify {
        info!(parent: &session_span, "TLS verification skipped (GATEWAY_SKIP_VERIFY_HOSTS)");
        (
            state.http_client_no_verify.clone(),
            state.ws_connector_no_verify.clone(),
        )
    } else {
        (state.http_client.clone(), state.ws_connector.clone())
    };
    let cache = Arc::clone(&state.cache);
    let approval_store = Arc::clone(&state.approval_store);
    let proxy_ctx = Arc::new(ProxyContext {
        project_id,
        organization_id,
        agent_id,
        agent_name,
        agent_identifier,
        agent_token: agent_token.clone(),
        client_identity,
    });

    // Taken here, before the spawn, so the session is tracked from the moment
    // it is promised rather than from whenever the new task first runs — the
    // accept task's own guard drops as soon as the upgrade is dispatched.
    let session_guard = crate::shutdown::task_guard();

    tokio::spawn(
        async move {
            match hyper::upgrade::on(req).await {
                Ok(upgraded) => {
                    let result = if intercept {
                        // A MITM session is HTTP: the drain waits for it, and
                        // its inner connection gets its own graceful shutdown.
                        let _guard = session_guard;
                        mitm::mitm(
                            upgraded,
                            &host,
                            &ca,
                            http_client,
                            ws_connector,
                            vault_injection_rules,
                            cache,
                            proxy_ctx,
                            approval_store,
                            Arc::clone(&state.policy_engine),
                        )
                        .await
                    } else {
                        // A raw tunnel is an indefinite byte pipe with no
                        // request boundary to finish on. Waiting for one would
                        // mean every shutdown takes the full deadline, so it is
                        // deliberately untracked and cut when the process exits.
                        drop(session_guard);
                        tunnel::tunnel(upgraded, &host).await
                    };
                    if let Err(e) = result {
                        warn!(host = %host, error = ?e, "connection error");
                    }
                }
                Err(e) => {
                    warn!(host = %host, error = %e, "upgrade failed");
                }
            }
        }
        .instrument(session_span),
    );

    // 200 tells the client the tunnel is established.
    Ok(Response::new(axum::body::Body::empty()))
}

// ── HTTP proxy handling ─────────────────────────────────────────────────

/// Handle a plain HTTP proxy request (absolute URI like `GET http(s)://host/path`).
///
/// Unlike CONNECT, there is no tunnel upgrade — the gateway reads the request
/// directly, applies credential injection, and forwards upstream over the
/// original scheme (reqwest handles TLS transparently for `https://`).
async fn handle_http_proxy(
    req: Request<Incoming>,
    peer_addr: SocketAddr,
    state: GatewayState,
    client_identity: Option<Arc<ClientIdentity>>,
    on_mtls: bool,
) -> Result<Response<axum::body::Body>, anyhow::Error> {
    let authority = req
        .uri()
        .authority()
        .context("HTTP proxy request missing authority")?
        .to_string();
    // Static-map to avoid borrowing from `req`, which is moved below.
    let scheme: &'static str = match req.uri().scheme_str() {
        Some("https") => "https",
        _ => "http",
    };
    let hostname = strip_port(&authority).to_string();

    let agent_token = inject::extract_agent_token(&req).filter(|t| !t.is_empty());

    let connection_id = connect::extract_connection_id(req.headers());

    let mut resolved = if let Some(ref token) = agent_token {
        match connect::resolve(token, &hostname, &state.policy_engine, &*state.cache).await {
            Ok(resp) => resp,
            Err(ConnectError::InvalidToken) => {
                warn!(peer = %peer_addr, host = %authority, "HTTP proxy rejected: invalid agent token");
                return Ok(response::proxy_auth_required());
            }
            Err(ConnectError::Internal(e)) => {
                warn!(peer = %peer_addr, host = %authority, error = %e, "HTTP proxy rejected: internal error");
                return Ok(response::bad_gateway());
            }
        }
    } else {
        connect::ConnectResponse::default()
    };

    // Phase 5: cert↔token tenant binding — AFTER `connect::resolve`, BEFORE
    // app-connection resolution / vault fallback / forwarding. See the
    // matching call (and its comment) in `handle_connect`; both go through
    // the ONE shared `enforce_binding` helper so the two entry points can't
    // drift from each other.
    if agent_token.is_some() {
        if let Some(denial) = enforce_binding(
            &state,
            on_mtls,
            client_identity.as_ref(),
            resolved.agent_id.as_deref(),
            resolved.project_id.as_deref().unwrap_or_default(),
            resolved.organization_id.as_deref(),
        )
        .await
        {
            return Ok(denial);
        }
    }

    // Per-request app connection disambiguation — app rules MERGE with the
    // secret rules (see inject::merge_injection_rules; #428). When the secret
    // rules already serve this request's path, app-side escalations are
    // best-effort no-ops rather than failures of a request the secret alone
    // satisfies.
    let mut resolved_finalizer: Option<crate::apps::RequestFinalizer> = None;
    let mut resolved_body_transform: Option<crate::apps::BodyTransform> = None;
    // Granular-access policy of the connection that wins injection (if any).
    let mut resolved_session_policy: Option<serde_json::Value> = None;
    // Id of the connection that wins injection — same attribution law as
    // `resolved_session_policy`; unlike `connection_label` below, it MUST be
    // threaded (policy decisions bind to it).
    let mut resolved_connection_id: Option<String> = None;
    if !resolved.app_connections.is_empty() {
        let oid = resolved.organization_id.as_deref().unwrap_or("");
        let pid = resolved.project_id.as_deref().unwrap_or("");
        let request_path = req.uri().path_and_query().map(|pq| pq.as_str());
        let secret_rules = std::mem::take(&mut resolved.injection_rules);
        let secrets_serve = inject::rules_serve_path(&secret_rules, request_path);
        let mut app_rules: Vec<inject::InjectionRule> = Vec::new();
        match state
            .policy_engine
            .resolve_app_injection_for_request(
                &resolved.app_connections,
                &hostname,
                request_path,
                connection_id.as_deref(),
                oid,
                pid,
                &*state.cache,
            )
            .await
        {
            Ok(AppConnectionResult::Rules {
                rules,
                finalizer,
                body_transform,
                session_policy,
                connection_id: winning_connection_id,
                ..
            }) => {
                app_rules = rules;
                resolved_finalizer = finalizer;
                resolved_body_transform = body_transform;
                resolved_session_policy = session_policy;
                resolved_connection_id = winning_connection_id;
            }
            Ok(AppConnectionResult::Ambiguous { connections }) => {
                if !secrets_serve {
                    return Ok(response::multiple_connections_axum(&connections));
                }
                debug!(host = %authority, "app connections ambiguous; secret rules serve this path");
            }
            Ok(AppConnectionResult::MultipleProviders { connections }) => {
                if !secrets_serve {
                    return Ok(response::multiple_providers_axum(&connections));
                }
                debug!(host = %authority, "multiple providers match; secret rules serve this path");
            }
            Ok(AppConnectionResult::NotFound { connections }) => {
                if !secrets_serve {
                    let cid = connection_id.as_deref().unwrap_or("");
                    return Ok(response::connection_not_found_axum(cid, &connections));
                }
                debug!(host = %authority, "requested connection not found; secret rules serve this path");
            }
            Ok(AppConnectionResult::NoConnections) => {}
            Err(e) => {
                if !secrets_serve {
                    warn!(peer = %peer_addr, host = %authority, error = ?e, "HTTP proxy: app connection resolution failed");
                    return Ok(response::bad_gateway());
                }
                warn!(peer = %peer_addr, host = %authority, error = ?e, "HTTP proxy: app resolution failed; proceeding with secret rules");
            }
        }
        resolved.injection_rules = inject::merge_injection_rules(app_rules, secret_rules);
    }

    // Vault fallback
    if resolved.injection_rules.is_empty() {
        if let Some(ref aid) = resolved.project_id {
            if let Some(cred) = state.vault_service.request_credential(aid, &hostname).await {
                let vault_rules = inject::vault_credential_to_rules(&hostname, &cred);
                if !vault_rules.is_empty() {
                    resolved.injection_rules = vault_rules;
                    info!(host = %hostname, project_id = %aid, "http_proxy: using vault credential");
                }
            }
        }
    }

    let session_span = info_span!("session",
        peer = %peer_addr,
        host = %authority,
        project_id = resolved.project_id.as_deref().unwrap_or("-"),
        org_id = resolved.organization_id.as_deref().unwrap_or("-"),
        agent = resolved.agent_name.as_deref().unwrap_or("-"),
        agent_id = resolved.agent_id.as_deref().unwrap_or("-"),
        client_identity = client_identity.as_deref().and_then(ClientIdentity::primary).unwrap_or("-"),
    );

    info!(
        parent: &session_span,
        scheme = %scheme,
        injection_count = resolved.injection_rules.len(),
        "HTTP_PROXY"
    );

    let proxy_ctx = ProxyContext {
        project_id: resolved.project_id,
        organization_id: resolved.organization_id,
        agent_id: resolved.agent_id,
        agent_name: resolved.agent_name,
        agent_identifier: resolved.agent_identifier,
        agent_token,
        client_identity,
    };

    let rules = mitm::ResolvedRules {
        injection_rules: resolved.injection_rules,
        policy_rules_v2: resolved.policy_rules_v2,
        available_apps: resolved.available_apps,
        access_restricted: resolved.access_restricted,
        intercept_token: None,
        plan: resolved.plan,
        rewrite_host: None,
        connection_label: None,
        finalizer: resolved_finalizer,
        body_transform: resolved_body_transform,
        claim_token: resolved.claim_token,
        session_policy: resolved_session_policy,
        winning_connection_id: resolved_connection_id,
        budget_bindings: resolved.budget_bindings,
    };

    let http_client =
        if scheme == "https" && host_matches_skip_verify(&hostname, &state.skip_verify_hosts) {
            state.http_client_no_verify.clone()
        } else {
            state.http_client.clone()
        };

    let mut resp = async {
        forward::forward_request(
            req,
            &authority, // forward target (the HTTP-proxy path never host-rewrites)
            &hostname,  // policy_host: host the rules were assembled from
            scheme,
            http_client,
            &rules,
            &*state.cache,
            &proxy_ctx,
            &state.approval_store,
            &state.policy_engine.pool,
        )
        .await
    }
    .instrument(session_span)
    .await?;

    connect::inject_connections_header(&mut resp, &resolved.app_connections);

    // Convert the response body type to match the axum::body::Body return type
    Ok(resp.map(axum::body::Body::new))
}

// ── Helpers ─────────────────────────────────────────────────────────────

/// Format a unix timestamp (seconds) as an ISO 8601 UTC string.
/// Falls back to epoch if the timestamp is invalid.
/// `pub(crate)` so the org route in `org_routes` can render timestamps identically.
pub(crate) fn format_unix_ts(secs: u64) -> String {
    use std::time::{Duration, UNIX_EPOCH};
    let dt = UNIX_EPOCH + Duration::from_secs(secs);
    // time crate is already a dependency (for certificate validity)
    let odt = time::OffsetDateTime::from(dt);
    odt.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

/// Strip port from a `host:port` string, returning just the hostname.
pub(crate) fn strip_port(host: &str) -> &str {
    host.split(':').next().unwrap_or(host)
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// `ClientConfig::builder()` panics when no process-default provider is
    /// installed, and both `ring` and `aws_lc_rs` are compiled in, so rustls
    /// cannot pick one on its own. `main` installs it at startup; tests must.
    fn ensure_crypto_provider() {
        static INIT_CRYPTO: std::sync::Once = std::sync::Once::new();
        INIT_CRYPTO.call_once(|| {
            let _ = rustls::crypto::ring::default_provider().install_default();
        });
    }

    /// Named for what it actually checks. An earlier version looped over both
    /// modes asserting only this, which a `build_ws_tls_config` that ignored
    /// its argument would have passed — the claim in the name has to be one
    /// the assertions can fail on. Which config a host *gets* is a behavioral
    /// claim, pinned end to end by the gateway-e2e suite against a self-signed
    /// upstream; rustls exposes no way to read a config's verifier back out.
    #[test]
    fn ws_tls_config_sets_http11_alpn() {
        ensure_crypto_provider();

        // ALPN is what makes the upstream answer HTTP/1.1 rather than
        // negotiating h2, which cannot carry an upgrade.
        let config = build_ws_tls_config(false);
        assert_eq!(config.alpn_protocols, vec![b"http/1.1".to_vec()]);
    }

    /// The dangerous branch takes a different builder chain, so it can fail to
    /// construct on its own — and it is the branch that almost never runs.
    #[test]
    fn ws_tls_config_builds_the_no_verify_branch() {
        ensure_crypto_provider();

        let config = build_ws_tls_config(true);
        assert_eq!(config.alpn_protocols, vec![b"http/1.1".to_vec()]);
    }

    /// The scheme list is what the ClientHello advertises. An empty one makes
    /// the server abort before it ever sends a certificate, so "skip
    /// verification" would surface as an unexplained handshake failure.
    #[test]
    fn accept_any_server_cert_advertises_signature_schemes() {
        use rustls::client::danger::ServerCertVerifier;

        let schemes = AcceptAnyServerCert.supported_verify_schemes();
        assert!(schemes.contains(&rustls::SignatureScheme::RSA_PKCS1_SHA256));
    }

    #[tokio::test]
    async fn healthz_reports_status_and_version() {
        let axum::Json(body) = healthz().await;
        assert_eq!(body["status"], "ok");
        assert!(
            body["version"].as_str().is_some_and(|v| !v.is_empty()),
            "healthz must report a non-empty version string",
        );
    }

    /// Verify that the production HTTP client does not follow redirects.
    /// A proxy must forward 3xx responses to the client so the client's HTTP
    /// library can see the full redirect chain (intermediate headers, etc.).
    #[tokio::test]
    async fn http_client_does_not_follow_redirects() {
        // Arrange: spin up a tiny server that always returns 302.
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let addr = listener.local_addr().expect("local addr");

        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                use std::io::{Read, Write};
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let resp = "HTTP/1.1 302 Found\r\n\
                            Location: http://example.com/other\r\n\
                            X-Repo-Commit: abc123\r\n\
                            Content-Length: 0\r\n\r\n";
                let _ = stream.write_all(resp.as_bytes());
            }
        });

        // Act: use the same client the gateway uses in production.
        let client = build_http_client(false);
        let resp = client
            .get(format!("http://{addr}/test"))
            .send()
            .await
            .expect("send request");

        // Assert: 302 is returned as-is, not followed.
        assert_eq!(resp.status(), 302, "proxy client must not follow redirects");
        assert_eq!(
            resp.headers().get("location").and_then(|v| v.to_str().ok()),
            Some("http://example.com/other"),
        );
        // Intermediate headers like X-Repo-Commit must be visible to the client.
        assert_eq!(
            resp.headers()
                .get("x-repo-commit")
                .and_then(|v| v.to_str().ok()),
            Some("abc123"),
        );
    }

    /// Build a `GatewayState` cheap enough for tests: a lazily-connected pool
    /// (`connect_lazy` never actually dials — nothing exercised by these
    /// tests touches the DB), an in-memory cache/approval store, and a local
    /// `CryptoService` key. None of this is real credential material; it
    /// exists only so the type checker is satisfied and `/healthz` (which
    /// touches none of these fields) can be routed to through the real
    /// `handle_connection` path.
    async fn test_gateway_state() -> GatewayState {
        use base64::Engine;

        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://test:test@127.0.0.1/test")
            .expect("lazy pool");
        let crypto = Arc::new(
            crate::crypto::CryptoService::from_base64_key(
                &base64::engine::general_purpose::STANDARD.encode([0u8; 32]),
            )
            .expect("crypto"),
        );
        let onepassword = Arc::new(crate::vault::onepassword::OnePasswordVaultProvider::new(
            pool.clone(),
            Arc::clone(&crypto),
        ));
        let policy_engine = Arc::new(PolicyEngine {
            pool: pool.clone(),
            crypto: Arc::clone(&crypto),
            onepassword: Arc::clone(&onepassword),
        });
        let bitwarden = crate::vault::bitwarden::BitwardenVaultProvider::new(
            crate::vault::bitwarden::BitwardenConfig {
                proxy_url: "wss://example.invalid".to_string(),
            },
            pool.clone(),
            Arc::clone(&crypto),
        );
        let providers: Vec<Arc<dyn vault::VaultProvider>> = vec![Arc::new(bitwarden), onepassword];
        let vault_service = Arc::new(vault::VaultService::new(providers, pool.clone()));
        let cache = crate::cache::create_store().await.expect("cache store");
        let approval_store = crate::approval::create_store()
            .await
            .expect("approval store");

        let tmp = tempfile::tempdir().expect("tempdir");
        let ca = crate::ca::CertificateAuthority::load_or_generate(tmp.path())
            .await
            .expect("test ca");

        GatewayState {
            ca: Arc::new(ca),
            http_client: build_http_client(false),
            http_client_no_verify: build_http_client(true),
            skip_verify_hosts: Arc::new(vec![]),
            ws_connector: TlsConnector::from(build_ws_tls_config(false)),
            ws_connector_no_verify: TlsConnector::from(build_ws_tls_config(true)),
            policy_engine,
            cache,
            vault_service,
            approval_store,
            client_ca: None,
            binding_mode: BindingMode::Off,
        }
    }

    /// End-to-end proof that Phase 1 mTLS *threads* identity but does not
    /// *enforce* on it: a client cert that verifies successfully is extracted
    /// into a `ClientIdentity` (asserted below), but a plain `GET /healthz`
    /// over that same connection still gets a normal 200 through the real
    /// `handle_connection` path — nothing gates on the identity yet.
    #[tokio::test]
    async fn mtls_valid_cert_reaches_healthz_with_no_enforcement() {
        static INIT: std::sync::Once = std::sync::Once::new();
        INIT.call_once(|| {
            let _ = rustls::crypto::ring::default_provider().install_default();
        });

        // Client CA + a leaf it signs.
        let ca_key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).expect("ca key");
        let mut ca_params = rcgen::CertificateParams::default();
        ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        ca_params
            .distinguished_name
            .push(rcgen::DnType::CommonName, "Test Client CA");
        ca_params.not_before = time::OffsetDateTime::now_utc() - time::Duration::hours(1);
        ca_params.not_after = time::OffsetDateTime::now_utc() + time::Duration::days(1);
        let ca_cert = ca_params.self_signed(&ca_key).expect("self-sign ca");
        let ca_pem = ca_cert.pem();

        let leaf_key =
            rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).expect("leaf key");
        let mut leaf_params = rcgen::CertificateParams::default();
        leaf_params
            .distinguished_name
            .push(rcgen::DnType::CommonName, "agent-1");
        leaf_params.not_before = time::OffsetDateTime::now_utc() - time::Duration::hours(1);
        leaf_params.not_after = time::OffsetDateTime::now_utc() + time::Duration::hours(24);
        let leaf_cert = leaf_params
            .signed_by(&leaf_key, &ca_cert, &ca_key)
            .expect("sign leaf");
        let leaf_pem = leaf_cert.pem();
        let leaf_key_pem = leaf_key.serialize_pem();

        // The gateway's own mTLS listener cert (self-signed, "localhost").
        let server_key =
            rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).expect("server key");
        let mut server_params =
            rcgen::CertificateParams::new(vec!["localhost".to_string()]).expect("params");
        server_params.not_before = time::OffsetDateTime::now_utc() - time::Duration::hours(1);
        server_params.not_after = time::OffsetDateTime::now_utc() + time::Duration::days(1);
        let server_cert = server_params
            .self_signed(&server_key)
            .expect("self-sign server");
        let server_pem = server_cert.pem();
        let server_key_pem = server_key.serialize_pem();
        let server_der = server_cert.der().clone();

        // A distinct CA standing in for "the gateway's MITM CA" — only used
        // to satisfy `from_parts`'s signature; unrelated to the client CA above.
        let mitm_key =
            rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).expect("mitm key");
        let mitm_cert = rcgen::CertificateParams::default()
            .self_signed(&mitm_key)
            .expect("self-sign mitm");
        let mitm_der = mitm_cert.der().clone();

        // Build the real ServerConfig through the same path main.rs uses.
        let mtls = client_ca::MtlsConfig::from_parts(
            Some("10256"),
            Some(&server_pem),
            Some(&server_key_pem),
            Some(&ca_pem),
            None,
            &mitm_der,
            10255,
        )
        .expect("from_parts")
        .expect("mtls configured");

        // Client trusts the server's self-signed cert directly and presents
        // the CA-signed leaf.
        let mut roots = rustls::RootCertStore::empty();
        roots.add(server_der).expect("trust server cert");
        let mut key_reader = leaf_key_pem.as_bytes();
        let client_key = rustls_pemfile::private_key(&mut key_reader)
            .expect("parse client key")
            .expect("client key present");
        let mut cert_reader = leaf_pem.as_bytes();
        let client_chain: Vec<_> = rustls_pemfile::certs(&mut cert_reader)
            .collect::<Result<_, _>>()
            .expect("client chain");
        let client_config = Arc::new(
            rustls::ClientConfig::builder()
                .with_root_certificates(roots)
                .with_client_auth_cert(client_chain, client_key)
                .expect("client auth cert"),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");

        let router = Router::new()
            .route("/healthz", axum::routing::get(healthz))
            .fallback(fallback);
        let state = test_gateway_state().await;

        let server_task = tokio::spawn(async move {
            let (stream, peer_addr) = listener.accept().await.expect("accept");
            let acceptor = TlsAcceptor::from(Arc::clone(&mtls.server_config));
            let tls_stream = acceptor.accept(stream).await.expect("server handshake");

            let client_identity = tls_stream
                .get_ref()
                .1
                .peer_certificates()
                .and_then(client_ca::identity_from_peer_certs)
                .map(Arc::new);
            assert!(client_identity.is_some(), "identity must be extracted");

            handle_connection(tls_stream, peer_addr, state, router, client_identity, true).await
        });

        let client_stream = tokio::net::TcpStream::connect(addr).await.expect("connect");
        let server_name = rustls::pki_types::ServerName::try_from("localhost").expect("name");
        let mut tls_client = tokio_rustls::TlsConnector::from(client_config)
            .connect(server_name, client_stream)
            .await
            .expect("client handshake");

        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        tls_client
            .write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .expect("write request");

        let mut response = Vec::new();
        tls_client
            .read_to_end(&mut response)
            .await
            .expect("read response");
        let response_str = String::from_utf8_lossy(&response);
        assert!(
            response_str.starts_with("HTTP/1.1 200"),
            "expected 200 OK (no enforcement in Phase 1), got: {response_str}"
        );

        server_task
            .await
            .expect("server task panicked")
            .expect("connection handled");
    }

    // ── strip_port ──────────────────────────────────────────────────────

    #[test]
    fn strip_port_removes_port() {
        assert_eq!(strip_port("example.com:443"), "example.com");
        assert_eq!(strip_port("api.anthropic.com:8080"), "api.anthropic.com");
    }

    #[test]
    fn strip_port_handles_bare_hostname() {
        assert_eq!(strip_port("example.com"), "example.com");
        assert_eq!(strip_port("localhost"), "localhost");
    }

    #[test]
    fn strip_port_handles_ipv6_no_brackets() {
        // IPv6 with port typically uses brackets, but strip_port just splits on ':'
        // For bracket-wrapped IPv6 like [::1]:443, it returns "[" — this is acceptable
        // since hyper always sends host:port format for CONNECT
        assert_eq!(strip_port("[::1]:443"), "[");
    }

    #[test]
    fn strip_port_handles_empty() {
        assert_eq!(strip_port(""), "");
    }

    // ── host_matches_skip_verify ─────────────────────────────────────────

    #[test]
    fn skip_verify_exact_match() {
        let patterns = vec!["internal.corp".to_string()];
        assert!(host_matches_skip_verify("internal.corp", &patterns));
        assert!(!host_matches_skip_verify("other.corp", &patterns));
        assert!(!host_matches_skip_verify("sub.internal.corp", &patterns));
    }

    #[test]
    fn skip_verify_wildcard_matches_subdomains_only() {
        let patterns = vec!["*.internal.corp".to_string()];
        assert!(host_matches_skip_verify("foo.internal.corp", &patterns));
        assert!(host_matches_skip_verify("a.b.internal.corp", &patterns));
        assert!(!host_matches_skip_verify("internal.corp", &patterns));
        assert!(!host_matches_skip_verify("notinternal.corp", &patterns));
        assert!(!host_matches_skip_verify("evil-internal.corp", &patterns));
    }

    #[test]
    fn skip_verify_case_insensitive_host() {
        // Patterns are pre-lowercased by parse_skip_verify_hosts.
        // The match function lowercases the host input.
        let patterns = vec!["internal.corp".to_string()];
        assert!(host_matches_skip_verify("INTERNAL.CORP", &patterns));
        assert!(host_matches_skip_verify("Internal.Corp", &patterns));
        assert!(host_matches_skip_verify("internal.corp", &patterns));
    }

    #[test]
    fn skip_verify_empty_patterns_never_matches() {
        assert!(!host_matches_skip_verify("anything.com", &[]));
    }

    // ── parse_skip_verify_patterns ─────────────────────────────────────

    /// Helper: parse a raw comma-separated string the same way `parse_skip_verify_hosts` does.
    fn parse_patterns(input: &str) -> Vec<String> {
        input
            .split(',')
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .collect()
    }

    #[test]
    fn parse_skip_verify_splits_and_trims() {
        let hosts = parse_patterns(" foo.com , *.bar.com , baz.io ");
        assert_eq!(hosts, vec!["foo.com", "*.bar.com", "baz.io"]);
    }

    #[test]
    fn parse_skip_verify_empty_input() {
        assert!(parse_patterns("").is_empty());
    }

    // ── parse_plain_bind_value ───────────────────────────────────────────

    #[test]
    fn plain_bind_defaults_to_unspecified_when_unset() {
        assert_eq!(
            parse_plain_bind_value(None).unwrap(),
            IpAddr::V4(Ipv4Addr::UNSPECIFIED)
        );
    }

    #[test]
    fn plain_bind_defaults_to_unspecified_when_empty() {
        assert_eq!(
            parse_plain_bind_value(Some("")).unwrap(),
            IpAddr::V4(Ipv4Addr::UNSPECIFIED)
        );
        assert_eq!(
            parse_plain_bind_value(Some("   ")).unwrap(),
            IpAddr::V4(Ipv4Addr::UNSPECIFIED)
        );
    }

    #[test]
    fn plain_bind_parses_valid_ip() {
        assert_eq!(
            parse_plain_bind_value(Some("127.0.0.1")).unwrap(),
            IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))
        );
    }

    /// FIX 1: a set-but-unparseable value must fail closed (`Err`), not
    /// silently fall back to the wide-open `0.0.0.0` default — that default
    /// is exactly what this knob exists to let an operator narrow.
    #[test]
    fn plain_bind_unparseable_value_errs_naming_var_and_value() {
        let err = parse_plain_bind_value(Some("127.0.0.q")).unwrap_err();
        let msg = format!("{err:#}");
        assert!(msg.contains("GATEWAY_PLAIN_BIND"), "message: {msg}");
        assert!(msg.contains("127.0.0.q"), "message: {msg}");
    }

    #[test]
    fn plain_bind_hostname_is_not_an_ip_literal_errs() {
        // "localhost" is a valid hostname but not an IP literal — parsing it
        // as an IpAddr must fail rather than silently resolve or default.
        assert!(parse_plain_bind_value(Some("localhost")).is_err());
    }

    // ── plain_bind_bypasses_binding_enforcement (Phase 5, security-review FIX 2) ──

    #[test]
    fn bypass_warning_fires_on_wildcard_ipv4_under_enforce() {
        assert!(plain_bind_bypasses_binding_enforcement(
            BindingMode::Enforce,
            IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        ));
    }

    /// FIX 2: unlike the plain `is_unspecified()` check this replaced, a
    /// specific-looking but still off-host-reachable address (a pod/cluster
    /// IP) must ALSO warn — it is exactly as reachable from outside this
    /// process as the wildcard address is.
    #[test]
    fn bypass_warning_fires_on_a_specific_non_loopback_address_under_enforce() {
        assert!(plain_bind_bypasses_binding_enforcement(
            BindingMode::Enforce,
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5)),
        ));
    }

    #[test]
    fn bypass_warning_silent_on_ipv4_loopback_under_enforce() {
        assert!(!plain_bind_bypasses_binding_enforcement(
            BindingMode::Enforce,
            IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)),
        ));
    }

    #[test]
    fn bypass_warning_silent_on_ipv6_loopback_under_enforce() {
        assert!(!plain_bind_bypasses_binding_enforcement(
            BindingMode::Enforce,
            IpAddr::V6(std::net::Ipv6Addr::LOCALHOST),
        ));
    }

    #[test]
    fn bypass_warning_silent_when_mode_is_not_enforce_even_on_wildcard() {
        for mode in [BindingMode::Off, BindingMode::Log] {
            assert!(
                !plain_bind_bypasses_binding_enforcement(mode, IpAddr::V4(Ipv4Addr::UNSPECIFIED)),
                "mode={mode:?}"
            );
        }
    }

    // ── is_http_proxy_request ──────────────────────────────────────────

    #[test]
    fn http_proxy_detected_for_absolute_uri() {
        let req = Request::builder()
            .uri("http://api.local:8080/v1/data")
            .body(())
            .unwrap();
        assert!(is_http_proxy_request(&req));
    }

    #[test]
    fn http_proxy_not_detected_for_relative_uri() {
        let req = Request::builder().uri("/healthz").body(()).unwrap();
        assert!(!is_http_proxy_request(&req));
    }

    #[test]
    fn http_proxy_detected_for_https_absolute_uri() {
        // axios v1.x with HTTPS_PROXY sends absolute-form https:// instead of CONNECT
        let req = Request::builder()
            .uri("https://api.example.com/data")
            .body(())
            .unwrap();
        assert!(is_http_proxy_request(&req));
    }

    #[test]
    fn http_proxy_not_detected_for_other_schemes() {
        // Non-http(s) schemes (ws://, ftp://, etc.) shouldn't be treated
        // as HTTP proxy requests.
        let req = Request::builder()
            .uri("ws://api.example.com/data")
            .body(())
            .unwrap();
        assert!(!is_http_proxy_request(&req));
    }

    // ── constant_time_eq / verify_secret ─────────────────────────────────

    #[test]
    fn constant_time_eq_equal_bytes_match() {
        assert!(constant_time_eq(b"same-value", b"same-value"));
    }

    #[test]
    fn constant_time_eq_different_bytes_do_not_match() {
        assert!(!constant_time_eq(b"same-value", b"other-value"));
    }

    #[test]
    fn constant_time_eq_different_lengths_do_not_match() {
        assert!(!constant_time_eq(b"short", b"a-much-longer-value"));
    }

    #[test]
    fn constant_time_eq_empty_slices_match() {
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn verify_secret_matches_the_correct_value() {
        assert!(verify_secret("hunter2", "hunter2"));
    }

    #[test]
    fn verify_secret_rejects_the_wrong_value() {
        assert!(!verify_secret("wrong", "hunter2"));
    }

    /// An empty configured secret must reject EVERY caller, including one
    /// presenting an empty header — never "match on emptiness". This is the
    /// property the internal client-cert endpoint's fail-closed posture
    /// depends on.
    #[test]
    fn verify_secret_empty_expected_rejects_everything() {
        assert!(!verify_secret("", ""));
        assert!(!verify_secret("anything", ""));
    }

    /// QA gap: the previous test only covers the empty-CONFIGURED-secret
    /// case. The more common real-world bug is the other direction — the
    /// server DOES have a real secret configured, and a caller sends an
    /// empty-string header (a client that forgot to set it, or a proxy that
    /// stripped the value but not the header). `constant_time_eq` already
    /// short-circuits on the length mismatch, but that must never be
    /// inferred from reading the code — assert it directly.
    #[test]
    fn verify_secret_empty_provided_against_a_real_configured_secret_is_rejected() {
        assert!(!verify_secret("", "a-real-configured-secret"));
    }

    // ── issue_client_cert handler ─────────────────────────────────────────

    const TEST_INTERNAL_SECRET: &str = "test-only-gateway-internal-secret";
    static INIT_INTERNAL_SECRET: std::sync::Once = std::sync::Once::new();

    /// Pin `GATEWAY_INTERNAL_SECRET` to one fixed known value for every test
    /// below that exercises `issue_client_cert`'s auth check.
    ///
    /// Safe under `cargo test`'s default parallelism even though
    /// `internal_secret()`'s `OnceLock` can only be initialized once per
    /// process: every caller of this function sets the SAME value before
    /// touching the handler, so whichever test thread's env write wins the
    /// race to initialize that `OnceLock`, the cached value is identical
    /// either way.
    fn ensure_internal_secret_configured() {
        INIT_INTERNAL_SECRET.call_once(|| {
            std::env::set_var("GATEWAY_INTERNAL_SECRET", TEST_INTERNAL_SECRET);
        });
    }

    fn header_map_with_secret(secret: &str) -> hyper::HeaderMap {
        let mut headers = hyper::HeaderMap::new();
        headers.insert(
            "x-gateway-secret",
            hyper::header::HeaderValue::from_str(secret).expect("valid header value"),
        );
        headers
    }

    #[tokio::test]
    async fn issue_client_cert_401s_without_the_secret_header() {
        ensure_internal_secret_configured();
        let state = test_gateway_state().await;
        let resp = issue_client_cert(
            State(state),
            hyper::HeaderMap::new(),
            axum::body::Bytes::from_static(b"{}"),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn issue_client_cert_401s_with_the_wrong_secret() {
        ensure_internal_secret_configured();
        let state = test_gateway_state().await;
        let resp = issue_client_cert(
            State(state),
            header_map_with_secret("not-the-right-secret"),
            axum::body::Bytes::from_static(b"{}"),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    /// QA gap: the server has a REAL, non-empty `GATEWAY_INTERNAL_SECRET`
    /// configured (`ensure_internal_secret_configured` guarantees this for
    /// every test in this file) — the caller is the one sending an
    /// empty-string header value (present header, empty value; a caller that
    /// forgot to set it, or a proxy that stripped the value but not the
    /// header). Must still 401, exercised at the actual handler, not just
    /// inferred from `verify_secret`'s pure-function test above.
    #[tokio::test]
    async fn issue_client_cert_401s_with_an_empty_secret_header_against_a_configured_secret() {
        ensure_internal_secret_configured();
        let state = test_gateway_state().await;
        let resp = issue_client_cert(
            State(state),
            header_map_with_secret(""),
            axum::body::Bytes::from_static(b"{}"),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    /// FIX 3 (security review): an explicit cap ahead of axum's own default
    /// body limit — the auth check (which never inspects the body) must not
    /// mask this: a correctly authenticated caller sending an oversized body
    /// still gets rejected, before any JSON parsing is attempted.
    #[tokio::test]
    async fn issue_client_cert_413s_on_an_oversized_body_even_with_the_right_secret() {
        ensure_internal_secret_configured();
        let state = test_gateway_state().await;
        let oversized = axum::body::Bytes::from(vec![b'a'; MAX_CLIENT_CERT_REQUEST_BODY_BYTES + 1]);
        let resp = issue_client_cert(
            State(state),
            header_map_with_secret(TEST_INTERNAL_SECRET),
            oversized,
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    /// A body right at the cap is NOT rejected by the size check (only
    /// `> MAX`, matching the plan's "cap", not an off-by-one).
    #[tokio::test]
    async fn issue_client_cert_accepts_a_body_exactly_at_the_cap_past_the_size_check() {
        ensure_internal_secret_configured();
        let state = test_gateway_state().await;
        // Right at the cap, but not valid JSON — proves the size check let
        // it through (400 from the JSON parse), not a size rejection (413).
        let mut body = vec![b' '; MAX_CLIENT_CERT_REQUEST_BODY_BYTES];
        body[0] = b'{'; // still invalid JSON, deliberately, to isolate the check under test
        let resp = issue_client_cert(
            State(state),
            header_map_with_secret(TEST_INTERNAL_SECRET),
            axum::body::Bytes::from(body),
        )
        .await
        .into_response();
        assert_ne!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn issue_client_cert_503s_when_no_minting_authority_is_configured() {
        ensure_internal_secret_configured();
        // `test_gateway_state()` leaves `client_ca: None` — the "operator set
        // GATEWAY_CLIENT_CA, no matching key" case described on the field's
        // doc comment and implemented in `main.rs`.
        let state = test_gateway_state().await;
        let resp = issue_client_cert(
            State(state),
            header_map_with_secret(TEST_INTERNAL_SECRET),
            axum::body::Bytes::from_static(
                br#"{"host_id":"h","spiffe_uri":"spiffe://onecli/host/h","csr_pem":"x"}"#,
            ),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn issue_client_cert_400s_on_malformed_json_with_a_valid_secret_and_authority() {
        ensure_internal_secret_configured();
        let tmp = tempfile::tempdir().expect("tempdir");
        let authority = client_ca_authority::ClientCa::load_or_generate(tmp.path())
            .await
            .expect("client ca authority");
        let mut state = test_gateway_state().await;
        state.client_ca = Some(Arc::new(authority));

        let resp = issue_client_cert(
            State(state),
            header_map_with_secret(TEST_INTERNAL_SECRET),
            axum::body::Bytes::from_static(b"not json"),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    // ── enforce_binding / resolve_host_tenant (Phase 5) ───────────────────
    //
    // `test_gateway_state()`'s pool is a `connect_lazy` handle to
    // `127.0.0.1` with nothing listening (see its doc comment) — no real
    // Postgres runs in this test binary. That is USED deliberately below,
    // not merely tolerated:
    //   - Cache-seeded scenarios never touch the DB at all (a cache hit
    //     returns before `db::find_client_host_by_spiffe` is ever called),
    //     so they exercise real code, not a stub.
    //   - The one scenario that must reach the DB (`enforce_binding` with
    //     nothing cached) gets a real `Err` from the doomed connection
    //     attempt — which IS the fail-closed path this suite needs to prove,
    //     obtained without hand-rolling a mock reader.
    // This is the plan's documented fallback ("stub the reader" when a live
    // DB isn't available in-crate) — here the "stub" is the cache, which is
    // real production code on the read path `resolve_host_tenant` already
    // exercises before ever reaching the DB.
    //
    // Both `handle_connect` and `handle_http_proxy` call the SAME
    // `enforce_binding` (see the two call sites above, right after each
    // one's `connect::resolve`) — there is exactly one implementation for
    // this suite to exercise, which is the structural guarantee that neither
    // entry point can quietly diverge from the other.

    fn binding_test_identity(spiffe: &str) -> Arc<ClientIdentity> {
        Arc::new(ClientIdentity {
            cn: None,
            uri_sans: vec![spiffe.to_string()],
            serial_hex: "ab".to_string(),
            not_after_unix: 0,
        })
    }

    /// A cert whose CN/SAN failed extraction (or was never sanitizable) —
    /// `ClientIdentity::primary()` returns `None`. Distinct from "no cert at
    /// all" (`on_mtls = false`): this identity came from a verified mTLS
    /// handshake, so `on_mtls = true` in every test that uses it.
    fn binding_test_unparseable_identity() -> Arc<ClientIdentity> {
        Arc::new(ClientIdentity {
            cn: None,
            uri_sans: vec![],
            serial_hex: "ab".to_string(),
            not_after_unix: 0,
        })
    }

    /// `revoked_at` is `TIMESTAMP` (no time zone — see `db::ClientHostRow`'s
    /// doc comment), so the stand-in "now" value must be a
    /// `PrimitiveDateTime`, not an `OffsetDateTime`.
    fn binding_test_host_row(
        project_id: &str,
        organization_id: Option<&str>,
        revoked: bool,
    ) -> db::ClientHostRow {
        let now = time::OffsetDateTime::now_utc();
        db::ClientHostRow {
            project_id: project_id.to_string(),
            organization_id: organization_id.map(str::to_string),
            revoked_at: revoked.then(|| time::PrimitiveDateTime::new(now.date(), now.time())),
        }
    }

    async fn seed_binding_cache(
        state: &GatewayState,
        spiffe: &str,
        row: Option<&db::ClientHostRow>,
    ) {
        state
            .cache
            .set(
                &format!("binding:host:{spiffe}"),
                &row,
                BINDING_CACHE_TTL_SECS,
            )
            .await;
    }

    async fn binding_state(mode: BindingMode) -> GatewayState {
        let mut state = test_gateway_state().await;
        state.binding_mode = mode;
        state
    }

    #[tokio::test]
    async fn enforce_binding_off_mode_allows_without_ever_resolving_the_host() {
        let state = binding_state(BindingMode::Off).await;
        // Deliberately unseeded: if `Off` resolved the host tenant anyway, it
        // would hit the dead test DB and this test would hang/slow down
        // rather than return immediately.
        let id = binding_test_identity("spiffe://onecli/host/off-1");
        let result =
            enforce_binding(&state, true, Some(&id), Some("agent-1"), "proj-A", None).await;
        assert!(result.is_none(), "Off must allow unconditionally");
    }

    #[tokio::test]
    async fn enforce_binding_plain_listener_exempt_even_under_enforce() {
        let state = binding_state(BindingMode::Enforce).await;
        let id = binding_test_identity("spiffe://onecli/host/plain-1");
        // on_mtls = false: must be exempt regardless of mode, unseeded cache,
        // or anything else — the plain listener never had a cert to bind.
        let result =
            enforce_binding(&state, false, Some(&id), Some("agent-1"), "proj-A", None).await;
        assert!(
            result.is_none(),
            "plain-listener requests are always exempt"
        );
    }

    #[tokio::test]
    async fn enforce_binding_matching_tenant_allows_under_enforce() {
        let state = binding_state(BindingMode::Enforce).await;
        let spiffe = "spiffe://onecli/host/match-1";
        seed_binding_cache(
            &state,
            spiffe,
            Some(&binding_test_host_row("proj-A", Some("org-1"), false)),
        )
        .await;
        let id = binding_test_identity(spiffe);
        let result = enforce_binding(
            &state,
            true,
            Some(&id),
            Some("agent-1"),
            "proj-A",
            Some("org-1"),
        )
        .await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn enforce_binding_mismatched_tenant_403s_under_enforce() {
        let state = binding_state(BindingMode::Enforce).await;
        let spiffe = "spiffe://onecli/host/mismatch-1";
        seed_binding_cache(
            &state,
            spiffe,
            Some(&binding_test_host_row("proj-B", None, false)),
        )
        .await;
        let id = binding_test_identity(spiffe);
        let result = enforce_binding(&state, true, Some(&id), Some("agent-1"), "proj-A", None)
            .await
            .expect("mismatched tenant must be denied under Enforce");
        assert_eq!(result.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn enforce_binding_mismatched_tenant_allowed_under_log_would_deny_only() {
        let state = binding_state(BindingMode::Log).await;
        let spiffe = "spiffe://onecli/host/mismatch-2";
        seed_binding_cache(
            &state,
            spiffe,
            Some(&binding_test_host_row("proj-B", None, false)),
        )
        .await;
        let id = binding_test_identity(spiffe);
        let result =
            enforce_binding(&state, true, Some(&id), Some("agent-1"), "proj-A", None).await;
        assert!(
            result.is_none(),
            "Log mode must allow (WouldDeny), never actually deny"
        );
    }

    #[tokio::test]
    async fn enforce_binding_off_mode_allows_even_a_cached_mismatch() {
        let state = binding_state(BindingMode::Off).await;
        let spiffe = "spiffe://onecli/host/off-2";
        seed_binding_cache(
            &state,
            spiffe,
            Some(&binding_test_host_row("proj-B", None, false)),
        )
        .await;
        let id = binding_test_identity(spiffe);
        let result =
            enforce_binding(&state, true, Some(&id), Some("agent-1"), "proj-A", None).await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn enforce_binding_revoked_host_403s_under_enforce() {
        let state = binding_state(BindingMode::Enforce).await;
        let spiffe = "spiffe://onecli/host/revoked-1";
        seed_binding_cache(
            &state,
            spiffe,
            Some(&binding_test_host_row("proj-A", None, true)),
        )
        .await;
        let id = binding_test_identity(spiffe);
        let result = enforce_binding(&state, true, Some(&id), Some("agent-1"), "proj-A", None)
            .await
            .expect("revoked host must be denied even with a matching project");
        assert_eq!(result.status(), StatusCode::FORBIDDEN);
    }

    /// Subtlety #1: an mTLS handshake with no extractable identity must be
    /// DENIED, not treated as an exempt plain-listener request.
    #[tokio::test]
    async fn enforce_binding_unparseable_identity_403s_under_enforce_not_exempt() {
        let state = binding_state(BindingMode::Enforce).await;
        let id = binding_test_unparseable_identity();
        let result = enforce_binding(&state, true, Some(&id), Some("agent-1"), "proj-A", None)
            .await
            .expect("a verified mTLS cert with no usable identity must be denied");
        assert_eq!(result.status(), StatusCode::FORBIDDEN);
    }

    /// Fail-closed on a lookup failure must be 502 (retryable), never 403
    /// (permanent) — a transient DB/cache outage is not a verdict about this
    /// identity. Unseeded cache + the dead test-DB pool together give a real
    /// lookup failure here, not a simulated one.
    #[tokio::test]
    async fn enforce_binding_db_error_502s_under_enforce_not_403() {
        let state = binding_state(BindingMode::Enforce).await;
        let id = binding_test_identity("spiffe://onecli/host/db-error-1");
        let result = enforce_binding(&state, true, Some(&id), Some("agent-1"), "proj-A", None)
            .await
            .expect("a lookup failure must fail closed (deny), not silently allow");
        assert_eq!(
            result.status(),
            StatusCode::BAD_GATEWAY,
            "a lookup failure is retryable — 502, not a permanent 403"
        );
    }

    #[tokio::test]
    async fn resolve_host_tenant_serves_a_cached_negative_result_without_touching_the_db() {
        let state = test_gateway_state().await;
        let spiffe = "spiffe://onecli/host/neg-1";
        // Cache an explicit "no such host" — proves negative results ride
        // the same `Option<ClientHostRow>` cache slot a positive one would,
        // and that a hit (positive OR negative) never reaches the DB.
        seed_binding_cache(&state, spiffe, None).await;
        let result = resolve_host_tenant(&state, spiffe).await;
        assert_eq!(result, Ok(None));
    }
}
