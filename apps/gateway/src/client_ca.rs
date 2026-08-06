//! mTLS client-certificate support: config assembly, TLS server config
//! construction, and identity extraction from the client certificate chain.
//!
//! Phase 1 (this module): the gateway can *require* a client certificate on a
//! dedicated port and *extract* an identity from it (CN / URI SAN), but never
//! compares that identity to anything — it's threaded onto [`crate::gateway::ProxyContext`]
//! and logged, nothing more. Phase 2 wires the actual enforcement (comparing
//! `client_identity` against `agent_token`) and CRL support (see the
//! `with_crls` hook noted in `build_server_config`).
//!
//! mTLS is entirely opt-in: unset `GATEWAY_MTLS_PORT` and this module never
//! touches a socket. That keeps the OSS build (and every existing deployment)
//! byte-for-byte backward compatible.

use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::server::WebPkiClientVerifier;
use rustls::{RootCertStore, ServerConfig};

// ── Identity ─────────────────────────────────────────────────────────────

/// Identity extracted from a client certificate that already passed the TLS
/// verifier's chain-of-trust and expiry checks.
///
/// Phase 1 only threads and logs this value — see the module doc. `primary()`
/// is the field Phase 2 will compare against the agent token.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ClientIdentity {
    pub(crate) cn: Option<String>,
    pub(crate) uri_sans: Vec<String>,
    pub(crate) serial_hex: String,
    pub(crate) not_after_unix: i64,
}

impl ClientIdentity {
    /// The identity used for logging (and, in Phase 2, matching): the first
    /// URI SAN if present — agents are expected to mint `spiffe://`-style
    /// URIs — else the Common Name.
    pub(crate) fn primary(&self) -> Option<&str> {
        self.uri_sans
            .first()
            .map(String::as_str)
            .or(self.cn.as_deref())
    }
}

impl std::fmt::Display for ClientIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.primary().unwrap_or("unknown"))
    }
}

/// Extract a [`ClientIdentity`] from the peer certificate chain presented
/// during the TLS handshake. `certs[0]` is the end-entity leaf — rustls
/// presents the chain leaf-first — intermediates are ignored.
///
/// Never panics: an empty slice, a leaf that fails to parse, or a hostile CN/
/// SAN (see [`sanitize_identity_component`]) all just fall through to `None`
/// pieces rather than a panic. The TLS verifier has already rejected chains
/// that don't verify by the time this runs, so there's nothing to fail closed
/// on here — Phase 1 doesn't enforce, it only reports what it saw.
pub(crate) fn identity_from_peer_certs(certs: &[CertificateDer<'_>]) -> Option<ClientIdentity> {
    let leaf = certs.first()?;
    let (_, cert) = x509_parser::parse_x509_certificate(leaf.as_ref()).ok()?;

    let cn = cert
        .subject()
        .iter_common_name()
        .next()
        .and_then(|attr| attr.as_str().ok())
        .and_then(sanitize_identity_component);

    let uri_sans = cert
        .subject_alternative_name()
        .ok()
        .flatten()
        .map(|ext| {
            ext.value
                .general_names
                .iter()
                .filter_map(|name| match name {
                    x509_parser::extensions::GeneralName::URI(uri) => Some(*uri),
                    _ => None,
                })
                .filter_map(sanitize_identity_component)
                .collect()
        })
        .unwrap_or_default();

    let serial_hex = hex::encode(cert.raw_serial());
    let not_after_unix = cert.validity().not_after.timestamp();

    Some(ClientIdentity {
        cn,
        uri_sans,
        serial_hex,
        not_after_unix,
    })
}

/// Validate a single identity component (a CN or a URI SAN) pulled from an
/// otherwise-trusted certificate. The certificate chains to a trust anchor,
/// but its *content* is still attacker-controlled (anyone who can get a cert
/// signed by the configured client CA picks their own CN/SAN) — this becomes
/// a log field and, in Phase 2, a lookup key, so control characters and
/// oversized values are dropped rather than "cleaned up": a component that
/// fails validation contributes nothing rather than a mangled value.
fn sanitize_identity_component(s: &str) -> Option<String> {
    if s.is_empty() || s.len() > 253 {
        return None;
    }
    // Printable ASCII only — this also excludes '\n'/'\r' (0x0A/0x0D), which
    // fall outside 0x20..=0x7E; '"' and '\\' are inside that range and need
    // an explicit check.
    if !s.chars().all(|c| matches!(c, '\u{20}'..='\u{7E}')) {
        return None;
    }
    if s.contains('"') || s.contains('\\') {
        return None;
    }
    Some(s.to_string())
}

// ── PEM / root store loading ─────────────────────────────────────────────

/// Resolve a PEM value from a raw string: a value starting with `-----BEGIN`
/// is treated as inline PEM (cloud injects CA/cert/key material this way,
/// from Secrets Manager); anything else is treated as a filesystem path (OSS
/// mounts files). Empty or unset input is `Ok(None)` — the caller decides
/// whether that's fatal.
fn pem_from_value(var_name: &str, value: &str) -> Result<Option<String>> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.starts_with("-----BEGIN") {
        return Ok(Some(trimmed.to_string()));
    }
    std::fs::read_to_string(trimmed)
        .map(Some)
        .with_context(|| format!("reading {var_name} from path {trimmed}"))
}

/// Same as [`pem_from_value`], reading the raw value from the environment.
#[cfg_attr(not(test), allow(dead_code))]
fn pem_from_env(var_name: &str) -> Result<Option<String>> {
    match std::env::var(var_name) {
        Ok(value) => pem_from_value(var_name, &value),
        Err(_) => Ok(None),
    }
}

/// Parse every certificate out of a PEM bundle. Errors if the PEM is
/// malformed or contains zero certificates — a client CA file that parses to
/// nothing is a misconfiguration, not "no CAs trusted".
fn pem_to_der_certs(pem: &str) -> Result<Vec<CertificateDer<'static>>> {
    let mut reader = pem.as_bytes();
    let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut reader)
        .collect::<Result<_, _>>()
        .context("parsing PEM certificate(s)")?;
    if certs.is_empty() {
        bail!("no certificates found in PEM");
    }
    Ok(certs)
}

/// Extract the DER-encoded SubjectPublicKeyInfo (SPKI) from a certificate —
/// "is this the same key", not "is this byte-identical certificate". Used by
/// the MITM-CA-reuse guard in `from_parts`: a certificate can be re-issued or
/// re-encoded (different serial, validity window, or DN) while wrapping the
/// exact same key pair, which a whole-certificate DER comparison would miss.
fn spki_der(cert_der: &CertificateDer<'_>) -> Result<Vec<u8>> {
    let (_, cert) = x509_parser::parse_x509_certificate(cert_der.as_ref())
        .context("parsing certificate to extract its public key")?;
    Ok(cert.public_key().raw.to_vec())
}

/// Build a [`RootCertStore`] from a PEM bundle of one or more CA certificates.
/// Reused by later phases (e.g. reloading the client CA bundle on rotation).
pub(crate) fn load_client_ca_roots(pem: &str) -> Result<Arc<RootCertStore>> {
    let certs = pem_to_der_certs(pem)?;
    let mut store = RootCertStore::empty();
    for cert in certs {
        store
            .add(cert)
            .context("adding client CA certificate to root store")?;
    }
    Ok(Arc::new(store))
}

// ── Server config ─────────────────────────────────────────────────────────

/// Build the mTLS `ServerConfig`: the gateway's own cert/key for the TLS
/// server side, plus `roots` as the trust anchor(s) for verifying client
/// certificates.
fn build_server_config(
    cert_pem: &str,
    key_pem: &str,
    roots: Arc<RootCertStore>,
) -> Result<Arc<ServerConfig>> {
    let cert_chain = pem_to_der_certs(cert_pem).context("parsing GATEWAY_TLS_CERT")?;

    let mut key_reader = key_pem.as_bytes();
    let key: PrivateKeyDer<'static> = rustls_pemfile::private_key(&mut key_reader)
        .context("parsing GATEWAY_TLS_KEY")?
        .context("no private key found in GATEWAY_TLS_KEY")?;

    // SECURITY: no `.allow_unauthenticated()` on this builder. The builder's
    // default policy — reject any handshake that doesn't present a certificate
    // verifiable against `roots` — IS the "no cert -> rejected" guarantee this
    // whole module exists to provide. Do not add it, even for a "convenience"
    // fallback: that would silently reopen the plaintext-equivalent hole this
    // port is meant to close.
    let verifier = WebPkiClientVerifier::builder(roots)
        .build()
        .context("building client certificate verifier")?;

    let mut config = ServerConfig::builder()
        .with_client_cert_verifier(verifier)
        .with_single_cert(cert_chain, key)
        .context("building mTLS ServerConfig")?;

    // Force HTTP/1.1 — same rationale as the MITM leaf configs (ca.rs):
    // prevent HTTP/2 negotiation via ALPN, since the gateway's connection
    // handling assumes HTTP/1.1 semantics (CONNECT interception, upgrades).
    config.alpn_protocols = vec![b"http/1.1".to_vec()];

    // Phase 2 hook: revocation lists would be wired in here via
    // `WebPkiClientVerifier::builder(roots).with_crls(...)`. Certificate
    // expiry is already validated by the webpki verifier itself — no manual
    // `not_after` check is needed (or added) on top of it.

    Ok(Arc::new(config))
}

// ── Config ────────────────────────────────────────────────────────────────

/// Resolved mTLS listener configuration. `None` (via [`MtlsConfig::from_env`])
/// means mTLS is off — the gateway runs exactly as it did before this module
/// existed.
#[derive(Debug)]
pub(crate) struct MtlsConfig {
    pub(crate) port: u16,
    pub(crate) bind: IpAddr,
    pub(crate) server_config: Arc<ServerConfig>,
}

impl MtlsConfig {
    /// Build the mTLS config from already-resolved parts — no environment
    /// access, so this is the unit-testable core. `from_env` is a thin
    /// wrapper that reads the four env vars and forwards here.
    ///
    /// `port`/`cert`/`key`/`ca` are the raw `GATEWAY_MTLS_PORT` /
    /// `GATEWAY_TLS_CERT` / `GATEWAY_TLS_KEY` / `GATEWAY_CLIENT_CA` values
    /// (or `None` if unset) — inline PEM or filesystem path, resolved here via
    /// [`pem_from_value`]. `mitm_ca_der` is the gateway's own MITM CA
    /// certificate (see `ca.rs`); `plain_port` is the plaintext listener port.
    ///
    /// `Ok(None)` means mTLS is off (port unset). Every other failure mode —
    /// unparseable/zero/colliding port, missing material, unreadable/garbage
    /// PEM, or a client CA that IS the MITM CA — is `Err`, and the caller
    /// (`main`) must fail closed: never fall back to plaintext-only when mTLS
    /// was requested but couldn't be built.
    pub(crate) fn from_parts(
        port: Option<&str>,
        cert: Option<&str>,
        key: Option<&str>,
        ca: Option<&str>,
        mitm_ca_der: &CertificateDer<'static>,
        plain_port: u16,
    ) -> Result<Option<MtlsConfig>> {
        let Some(port_str) = port else {
            // GATEWAY_MTLS_PORT unset: mTLS is off. Full backward compatibility.
            return Ok(None);
        };

        let port: u16 = port_str.parse().with_context(|| {
            format!("GATEWAY_MTLS_PORT {port_str:?} is not a valid port number")
        })?;
        if port == 0 {
            bail!("GATEWAY_MTLS_PORT must not be 0");
        }
        if port == plain_port {
            bail!(
                "GATEWAY_MTLS_PORT ({port}) must differ from the plaintext gateway port ({plain_port})"
            );
        }

        let cert_pem = cert
            .context("GATEWAY_TLS_CERT is required when GATEWAY_MTLS_PORT is set")
            .and_then(|v| pem_from_value("GATEWAY_TLS_CERT", v))?
            .context("GATEWAY_TLS_CERT is required when GATEWAY_MTLS_PORT is set")?;
        let key_pem = key
            .context("GATEWAY_TLS_KEY is required when GATEWAY_MTLS_PORT is set")
            .and_then(|v| pem_from_value("GATEWAY_TLS_KEY", v))?
            .context("GATEWAY_TLS_KEY is required when GATEWAY_MTLS_PORT is set")?;
        let ca_pem = ca
            .context("GATEWAY_CLIENT_CA is required when GATEWAY_MTLS_PORT is set")
            .and_then(|v| pem_from_value("GATEWAY_CLIENT_CA", v))?
            .context("GATEWAY_CLIENT_CA is required when GATEWAY_MTLS_PORT is set")?;

        // SECURITY: reject a client CA bundle that carries the same public
        // key as the gateway's own MITM CA. Compared on the DER-encoded
        // SubjectPublicKeyInfo (SPKI), not the whole-certificate DER: the real
        // risk is the MITM CA's *private key* being host-resident (it signs a
        // fresh leaf for every intercepted domain), and a re-issued or
        // re-encoded certificate wrapping that SAME key would byte-differ
        // from the original cert while remaining exactly as dangerous to
        // trust — a whole-cert comparison would miss it.  If ANY certificate
        // carrying that key were trusted as a client-cert anchor, anyone able
        // to mint a MITM leaf could just as easily mint a "valid" client cert
        // and impersonate any agent.
        let mitm_spki =
            spki_der(mitm_ca_der).context("parsing the gateway's own MITM CA certificate")?;
        let ca_certs = pem_to_der_certs(&ca_pem).context("parsing GATEWAY_CLIENT_CA")?;
        for cert in &ca_certs {
            let spki = spki_der(cert)
                .context("GATEWAY_CLIENT_CA contains a certificate that failed to parse")?;
            if spki == mitm_spki {
                bail!(
                    "GATEWAY_CLIENT_CA must not include a certificate carrying the same public \
                     key as the gateway's own MITM CA (its private key lives on this host, so \
                     trusting that key as a client anchor would let anyone mint their own \
                     client certificate)"
                );
            }
        }

        let roots = load_client_ca_roots(&ca_pem).context("GATEWAY_CLIENT_CA")?;
        let server_config = build_server_config(&cert_pem, &key_pem, roots)?;

        Ok(Some(MtlsConfig {
            port,
            bind: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            server_config,
        }))
    }

    /// Read `GATEWAY_MTLS_PORT` / `GATEWAY_TLS_CERT` / `GATEWAY_TLS_KEY` /
    /// `GATEWAY_CLIENT_CA` from the environment and forward to [`Self::from_parts`].
    pub(crate) fn from_env(
        mitm_ca_der: &CertificateDer<'static>,
        plain_port: u16,
    ) -> Result<Option<MtlsConfig>> {
        let port = std::env::var("GATEWAY_MTLS_PORT").ok();
        let cert = std::env::var("GATEWAY_TLS_CERT").ok();
        let key = std::env::var("GATEWAY_TLS_KEY").ok();
        let ca = std::env::var("GATEWAY_CLIENT_CA").ok();
        Self::from_parts(
            port.as_deref(),
            cert.as_deref(),
            key.as_deref(),
            ca.as_deref(),
            mitm_ca_der,
            plain_port,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::SocketAddr;
    use std::sync::Once;
    use std::time::{SystemTime, UNIX_EPOCH};

    use rcgen::{
        BasicConstraints, CertificateParams, DnType, IsCa, KeyPair, KeyUsagePurpose,
        PKCS_ECDSA_P256_SHA256,
    };
    use rustls::pki_types::ServerName;
    use time::OffsetDateTime;
    use tokio::net::{TcpListener, TcpStream};
    use tokio_rustls::{TlsAcceptor, TlsConnector};

    static INIT_CRYPTO: Once = Once::new();

    fn ensure_crypto_provider() {
        INIT_CRYPTO.call_once(|| {
            // Ignore the error: it just means another test module (e.g.
            // `ca`) already installed the process-wide default in this same
            // test binary — a no-op for our purposes either way, since it's
            // the same `ring` provider.
            let _ = rustls::crypto::ring::default_provider().install_default();
        });
    }

    // ── sanitize_identity_component ─────────────────────────────────────

    #[test]
    fn sanitize_accepts_plain_values() {
        assert_eq!(
            sanitize_identity_component("agent-42"),
            Some("agent-42".to_string())
        );
        assert_eq!(
            sanitize_identity_component("spiffe://onecli/agent/42"),
            Some("spiffe://onecli/agent/42".to_string())
        );
    }

    #[test]
    fn sanitize_drops_empty() {
        assert_eq!(sanitize_identity_component(""), None);
    }

    #[test]
    fn sanitize_drops_oversized() {
        let long = "a".repeat(254);
        assert_eq!(sanitize_identity_component(&long), None);
        // 253 bytes is the boundary — still accepted.
        let boundary = "a".repeat(253);
        assert!(sanitize_identity_component(&boundary).is_some());
    }

    #[test]
    fn sanitize_drops_newline_and_cr() {
        assert_eq!(sanitize_identity_component("agent\n42"), None);
        assert_eq!(sanitize_identity_component("agent\r42"), None);
    }

    #[test]
    fn sanitize_drops_quote_and_backslash() {
        assert_eq!(sanitize_identity_component("agent\"42"), None);
        assert_eq!(sanitize_identity_component("agent\\42"), None);
    }

    #[test]
    fn sanitize_drops_non_ascii() {
        assert_eq!(sanitize_identity_component("agenté"), None);
    }

    // ── ClientIdentity::primary ──────────────────────────────────────────

    #[test]
    fn primary_prefers_uri_san_over_cn() {
        let id = ClientIdentity {
            cn: Some("fallback-cn".to_string()),
            uri_sans: vec!["spiffe://onecli/agent/1".to_string()],
            serial_hex: "ab".to_string(),
            not_after_unix: 0,
        };
        assert_eq!(id.primary(), Some("spiffe://onecli/agent/1"));
    }

    #[test]
    fn primary_falls_back_to_cn() {
        let id = ClientIdentity {
            cn: Some("cn-only".to_string()),
            uri_sans: vec![],
            serial_hex: "ab".to_string(),
            not_after_unix: 0,
        };
        assert_eq!(id.primary(), Some("cn-only"));
    }

    #[test]
    fn primary_none_when_both_missing() {
        let id = ClientIdentity {
            cn: None,
            uri_sans: vec![],
            serial_hex: "ab".to_string(),
            not_after_unix: 0,
        };
        assert_eq!(id.primary(), None);
    }

    #[test]
    fn display_uses_primary() {
        let id = ClientIdentity {
            cn: Some("cn-only".to_string()),
            uri_sans: vec![],
            serial_hex: "ab".to_string(),
            not_after_unix: 0,
        };
        assert_eq!(id.to_string(), "cn-only");
    }

    // ── identity_from_peer_certs: empty/malformed input never panics ────

    #[test]
    fn identity_from_empty_slice_is_none() {
        assert_eq!(identity_from_peer_certs(&[]), None);
    }

    #[test]
    fn identity_from_garbage_der_is_none() {
        let garbage = CertificateDer::from(vec![0u8, 1, 2, 3, 4]);
        assert_eq!(
            identity_from_peer_certs(std::slice::from_ref(&garbage)),
            None
        );
    }

    // ── test PKI helper ───────────────────────────────────────────────────

    /// A minimal CA + leaf-signing helper built on rcgen, mirroring the
    /// pattern in `ca.rs`'s own test module.
    struct TestCa {
        cert: rcgen::Certificate,
        key: KeyPair,
        der: CertificateDer<'static>,
    }

    fn new_test_ca(cn: &str) -> TestCa {
        let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("CA key");
        let mut params = CertificateParams::default();
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.distinguished_name.push(DnType::CommonName, cn);
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        params.not_before = OffsetDateTime::now_utc() - time::Duration::hours(1);
        params.not_after = OffsetDateTime::now_utc() + time::Duration::days(3650);
        let cert = params.self_signed(&key).expect("self-sign CA");
        let der = cert.der().clone();
        TestCa { cert, key, der }
    }

    /// Sign a client leaf under `ca`, valid `[not_before_h, not_after_h]` hours
    /// from now, with the given CN and URI SANs. Returns (cert_pem, key_pem).
    fn sign_client_leaf(
        ca: &TestCa,
        cn: Option<&str>,
        uri_sans: &[&str],
        not_before_h: i64,
        not_after_h: i64,
    ) -> (String, String) {
        let leaf_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("leaf key");
        let mut params = CertificateParams::default();
        // `CertificateParams::new(strings)` only ever infers IP or DNS SANs —
        // a "spiffe://..."-shaped string comes out as a (nonsensical) DNS
        // name, not a URI SAN. Push `SanType::URI` directly instead.
        params.subject_alt_names = uri_sans
            .iter()
            .map(|s| {
                rcgen::SanType::URI(
                    rcgen::Ia5String::try_from(s.to_string()).expect("valid IA5 URI"),
                )
            })
            .collect();
        if let Some(cn) = cn {
            params.distinguished_name.push(DnType::CommonName, cn);
        }
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ClientAuth];
        params.not_before = OffsetDateTime::now_utc() + time::Duration::hours(not_before_h);
        params.not_after = OffsetDateTime::now_utc() + time::Duration::hours(not_after_h);
        let leaf_cert = params
            .signed_by(&leaf_key, &ca.cert, &ca.key)
            .expect("sign leaf");
        (leaf_cert.pem(), leaf_key.serialize_pem())
    }

    /// Self-signed "server" cert for `localhost`, used as the mTLS listener's
    /// own identity in handshake tests. The test client trusts it directly
    /// (it's its own root), sidestepping the need for a fake server verifier.
    fn self_signed_server_cert() -> (String, String, CertificateDer<'static>) {
        let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("server key");
        let mut params = CertificateParams::new(vec!["localhost".to_string()]).expect("params");
        params
            .distinguished_name
            .push(DnType::CommonName, "localhost");
        params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
        params.not_before = OffsetDateTime::now_utc() - time::Duration::hours(1);
        params.not_after = OffsetDateTime::now_utc() + time::Duration::days(1);
        let cert = params.self_signed(&key).expect("self-sign server cert");
        let der = cert.der().clone();
        (cert.pem(), key.serialize_pem(), der)
    }

    /// Build a server config AND return the matching server cert DER — the
    /// two must come from the same `self_signed_server_cert()` call, since
    /// the test client trusts that DER directly as its only root.
    fn test_server_setup(trusted_ca_pem: &str) -> (Arc<ServerConfig>, CertificateDer<'static>) {
        let (server_cert_pem, server_key_pem, server_der) = self_signed_server_cert();
        let roots = load_client_ca_roots(trusted_ca_pem).expect("roots");
        let config =
            build_server_config(&server_cert_pem, &server_key_pem, roots).expect("server config");
        (config, server_der)
    }

    fn test_client_config(
        server_der: &CertificateDer<'static>,
        client_cert_pem: Option<&str>,
        client_key_pem: Option<&str>,
    ) -> Arc<rustls::ClientConfig> {
        let mut roots = RootCertStore::empty();
        roots.add(server_der.clone()).expect("trust server cert");

        let builder = rustls::ClientConfig::builder().with_root_certificates(roots);
        let config = match (client_cert_pem, client_key_pem) {
            (Some(cert_pem), Some(key_pem)) => {
                let chain = pem_to_der_certs(cert_pem).expect("client cert chain");
                let mut key_reader = key_pem.as_bytes();
                let key = rustls_pemfile::private_key(&mut key_reader)
                    .expect("parse client key")
                    .expect("client key present");
                builder
                    .with_client_auth_cert(chain, key)
                    .expect("client auth cert")
            }
            _ => builder.with_no_client_auth(),
        };
        Arc::new(config)
    }

    /// Run one TLS handshake end to end over a real loopback socket (same
    /// pattern as the plain-TCP tests in `gateway.rs`/`ca.rs`, just over TLS).
    /// Returns the server-side accept result — the thing under test — and
    /// discards the client-side result beyond confirming it also failed when
    /// the server did (a rejected handshake fails both sides).
    async fn attempt_handshake(
        server_config: Arc<ServerConfig>,
        client_config: Arc<rustls::ClientConfig>,
    ) -> std::io::Result<tokio_rustls::server::TlsStream<TcpStream>> {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr: SocketAddr = listener.local_addr().expect("local addr");

        let server = async move {
            let (stream, _) = listener.accept().await?;
            TlsAcceptor::from(server_config).accept(stream).await
        };
        let client = async move {
            let stream = TcpStream::connect(addr).await?;
            let name = ServerName::try_from("localhost").expect("server name");
            TlsConnector::from(client_config)
                .connect(name, stream)
                .await
        };

        let (server_result, _client_result) = tokio::join!(server, client);
        server_result
    }

    fn err_debug_contains(err: &std::io::Error, needle: &str) -> bool {
        format!("{err:?}").contains(needle)
    }

    // ── Handshake behavior ────────────────────────────────────────────────

    #[tokio::test]
    async fn handshake_rejects_missing_client_cert() {
        ensure_crypto_provider();
        let ca = new_test_ca("Test Client CA");
        let ca_pem = ca.cert.pem();
        let (server_config, server_der) = test_server_setup(&ca_pem);
        let client_config = test_client_config(&server_der, None, None);

        let result = attempt_handshake(server_config, client_config).await;
        let err = result.expect_err("handshake without a client cert must fail");
        assert!(
            err_debug_contains(&err, "NoCertificatesPresented")
                || err_debug_contains(&err, "CertificateRequired"),
            "unexpected error: {err:?}"
        );
    }

    #[tokio::test]
    async fn handshake_rejects_wrong_ca() {
        ensure_crypto_provider();
        let trusted_ca = new_test_ca("Trusted Client CA");
        let other_ca = new_test_ca("Some Other CA");
        let (cert_pem, key_pem) = sign_client_leaf(&other_ca, Some("agent-1"), &[], -1, 24);

        let (server_config, server_der) = test_server_setup(&trusted_ca.cert.pem());
        let client_config = test_client_config(&server_der, Some(&cert_pem), Some(&key_pem));

        let result = attempt_handshake(server_config, client_config).await;
        let err = result.expect_err("handshake signed by an untrusted CA must fail");
        assert!(
            err_debug_contains(&err, "UnknownIssuer"),
            "unexpected error: {err:?}"
        );
    }

    #[tokio::test]
    async fn handshake_rejects_expired_cert() {
        ensure_crypto_provider();
        let ca = new_test_ca("Trusted Client CA");
        // Valid window entirely in the past.
        let (cert_pem, key_pem) = sign_client_leaf(&ca, Some("agent-1"), &[], -48, -24);

        let (server_config, server_der) = test_server_setup(&ca.cert.pem());
        let client_config = test_client_config(&server_der, Some(&cert_pem), Some(&key_pem));

        let result = attempt_handshake(server_config, client_config).await;
        let err = result.expect_err("handshake with an expired client cert must fail");
        assert!(
            err_debug_contains(&err, "Expired"),
            "unexpected error: {err:?}"
        );
    }

    #[tokio::test]
    async fn handshake_accepts_valid_cert_with_uri_san() {
        ensure_crypto_provider();
        let ca = new_test_ca("Trusted Client CA");
        let (cert_pem, key_pem) = sign_client_leaf(
            &ca,
            Some("fallback-cn"),
            &["spiffe://onecli/agent/1"],
            -1,
            24,
        );

        let (server_config, server_der) = test_server_setup(&ca.cert.pem());
        let client_config = test_client_config(&server_der, Some(&cert_pem), Some(&key_pem));

        let mut tls_stream = attempt_handshake(server_config, client_config)
            .await
            .expect("valid client cert must be accepted");

        let identity = tls_stream
            .get_ref()
            .1
            .peer_certificates()
            .and_then(identity_from_peer_certs)
            .expect("identity must be extracted");
        assert_eq!(identity.primary(), Some("spiffe://onecli/agent/1"));
        assert_eq!(identity.cn.as_deref(), Some("fallback-cn"));

        // Drain so the client side's write half doesn't hang the test.
        use tokio::io::AsyncWriteExt;
        let _ = tls_stream.shutdown().await;
    }

    #[tokio::test]
    async fn handshake_accepts_valid_cert_cn_only() {
        ensure_crypto_provider();
        let ca = new_test_ca("Trusted Client CA");
        let (cert_pem, key_pem) = sign_client_leaf(&ca, Some("cn-only-agent"), &[], -1, 24);

        let (server_config, server_der) = test_server_setup(&ca.cert.pem());
        let client_config = test_client_config(&server_der, Some(&cert_pem), Some(&key_pem));

        let mut tls_stream = attempt_handshake(server_config, client_config)
            .await
            .expect("valid client cert must be accepted");

        let identity = tls_stream
            .get_ref()
            .1
            .peer_certificates()
            .and_then(identity_from_peer_certs)
            .expect("identity must be extracted");
        assert_eq!(identity.primary(), Some("cn-only-agent"));
        assert!(identity.uri_sans.is_empty());

        use tokio::io::AsyncWriteExt;
        let _ = tls_stream.shutdown().await;
    }

    #[tokio::test]
    async fn server_config_pins_http11_alpn() {
        ensure_crypto_provider();
        let ca = new_test_ca("Trusted Client CA");
        let (config, _server_der) = test_server_setup(&ca.cert.pem());
        assert_eq!(config.alpn_protocols, vec![b"http/1.1".to_vec()]);
    }

    // ── from_parts: no env access ────────────────────────────────────────

    fn dummy_mitm_ca_der() -> CertificateDer<'static> {
        new_test_ca("Dummy MITM CA").der
    }

    #[test]
    fn from_parts_port_none_is_off() {
        ensure_crypto_provider();
        let mitm_der = dummy_mitm_ca_der();
        let result = MtlsConfig::from_parts(None, None, None, None, &mitm_der, 10255).unwrap();
        assert!(result.is_none());
    }

    /// Stands in for "this field is present" in `from_parts` tests that only
    /// care about a *different* field. Must start with `-----BEGIN` so
    /// `pem_from_value` takes the inline-PEM branch rather than trying (and
    /// failing) to read it as a filesystem path — its content is never
    /// actually parsed in these tests, since the function under test returns
    /// before reaching that point.
    const PRESENT_PLACEHOLDER_PEM: &str =
        "-----BEGIN CERTIFICATE-----\nplaceholder\n-----END CERTIFICATE-----\n";

    #[test]
    fn from_parts_missing_cert_errs_naming_it() {
        ensure_crypto_provider();
        let mitm_der = dummy_mitm_ca_der();
        let err = MtlsConfig::from_parts(
            Some("10256"),
            None,
            Some("key"),
            Some("ca"),
            &mitm_der,
            10255,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("GATEWAY_TLS_CERT"));
    }

    #[test]
    fn from_parts_missing_key_errs_naming_it() {
        ensure_crypto_provider();
        let mitm_der = dummy_mitm_ca_der();
        let err = MtlsConfig::from_parts(
            Some("10256"),
            Some(PRESENT_PLACEHOLDER_PEM),
            None,
            Some(PRESENT_PLACEHOLDER_PEM),
            &mitm_der,
            10255,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("GATEWAY_TLS_KEY"));
    }

    #[test]
    fn from_parts_missing_ca_errs_naming_it() {
        ensure_crypto_provider();
        let mitm_der = dummy_mitm_ca_der();
        let err = MtlsConfig::from_parts(
            Some("10256"),
            Some(PRESENT_PLACEHOLDER_PEM),
            Some(PRESENT_PLACEHOLDER_PEM),
            None,
            &mitm_der,
            10255,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("GATEWAY_CLIENT_CA"));
    }

    #[test]
    fn from_parts_zero_port_errs() {
        ensure_crypto_provider();
        let mitm_der = dummy_mitm_ca_der();
        let err =
            MtlsConfig::from_parts(Some("0"), Some("c"), Some("k"), Some("a"), &mitm_der, 10255)
                .unwrap_err();
        assert!(format!("{err:#}").contains("must not be 0"));
    }

    #[test]
    fn from_parts_garbage_port_errs() {
        ensure_crypto_provider();
        let mitm_der = dummy_mitm_ca_der();
        let err = MtlsConfig::from_parts(
            Some("not-a-port"),
            Some("c"),
            Some("k"),
            Some("a"),
            &mitm_der,
            10255,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("not a valid port"));
    }

    #[test]
    fn from_parts_port_equals_plain_port_errs() {
        ensure_crypto_provider();
        let mitm_der = dummy_mitm_ca_der();
        let err = MtlsConfig::from_parts(
            Some("10255"),
            Some("c"),
            Some("k"),
            Some("a"),
            &mitm_der,
            10255,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("must differ"));
    }

    #[test]
    fn from_parts_loads_inline_pem_and_path_forms() {
        ensure_crypto_provider();
        let ca = new_test_ca("Trusted Client CA");
        let (server_cert_pem, server_key_pem, _) = self_signed_server_cert();
        let mitm_der = dummy_mitm_ca_der();
        let ca_pem = ca.cert.pem();

        // Inline PEM form for all three.
        let result = MtlsConfig::from_parts(
            Some("10256"),
            Some(&server_cert_pem),
            Some(&server_key_pem),
            Some(&ca_pem),
            &mitm_der,
            10255,
        )
        .expect("inline PEM must load");
        assert!(result.is_some());

        // Path form: write each to a tempfile and pass the path.
        let dir = tempfile::tempdir().expect("tempdir");
        let cert_path = dir.path().join("cert.pem");
        let key_path = dir.path().join("key.pem");
        let ca_path = dir.path().join("ca.pem");
        std::fs::write(&cert_path, &server_cert_pem).expect("write cert");
        std::fs::write(&key_path, &server_key_pem).expect("write key");
        std::fs::write(&ca_path, &ca_pem).expect("write ca");

        let result = MtlsConfig::from_parts(
            Some("10256"),
            Some(cert_path.to_str().unwrap()),
            Some(key_path.to_str().unwrap()),
            Some(ca_path.to_str().unwrap()),
            &mitm_der,
            10255,
        )
        .expect("path form must load");
        assert!(result.is_some());
    }

    #[test]
    fn from_parts_bad_path_errs() {
        ensure_crypto_provider();
        let mitm_der = dummy_mitm_ca_der();
        let err = MtlsConfig::from_parts(
            Some("10256"),
            Some("/nonexistent/path/cert.pem"),
            Some("/nonexistent/path/key.pem"),
            Some("/nonexistent/path/ca.pem"),
            &mitm_der,
            10255,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("GATEWAY_TLS_CERT"));
    }

    #[test]
    fn from_parts_garbage_pem_errs() {
        ensure_crypto_provider();
        let mitm_der = dummy_mitm_ca_der();
        let (server_cert_pem, server_key_pem, _) = self_signed_server_cert();
        let err = MtlsConfig::from_parts(
            Some("10256"),
            Some(&server_cert_pem),
            Some(&server_key_pem),
            Some("-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydA==\n-----END CERTIFICATE-----\n"),
            &mitm_der,
            10255,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("GATEWAY_CLIENT_CA"));
    }

    #[test]
    fn from_parts_empty_client_ca_errs() {
        ensure_crypto_provider();
        let mitm_der = dummy_mitm_ca_der();
        let (server_cert_pem, server_key_pem, _) = self_signed_server_cert();
        // Empty value resolves to None via pem_from_value, which is then the
        // "missing" case for a mandatory var.
        let err = MtlsConfig::from_parts(
            Some("10256"),
            Some(&server_cert_pem),
            Some(&server_key_pem),
            Some(""),
            &mitm_der,
            10255,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("GATEWAY_CLIENT_CA"));
    }

    #[test]
    fn from_parts_rejects_client_ca_matching_mitm_ca() {
        ensure_crypto_provider();
        let mitm_ca = new_test_ca("Gateway MITM CA");
        let (server_cert_pem, server_key_pem, _) = self_signed_server_cert();

        // GATEWAY_CLIENT_CA is (accidentally) the same cert as the MITM CA.
        let err = MtlsConfig::from_parts(
            Some("10256"),
            Some(&server_cert_pem),
            Some(&server_key_pem),
            Some(&mitm_ca.cert.pem()),
            &mitm_ca.der,
            10255,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("MITM CA"));
    }

    /// FIX 3: the guard compares public keys (SPKI), not whole-certificate
    /// DER — a certificate carrying the SAME key as the MITM CA must still be
    /// rejected even though it's a byte-different certificate (different CN,
    /// serial, and validity window — e.g. a re-issued or re-encoded cert).
    #[test]
    fn from_parts_rejects_client_ca_with_same_public_key_as_mitm_ca_even_if_cert_differs() {
        ensure_crypto_provider();

        let mitm_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("mitm key");
        let mut mitm_params = CertificateParams::default();
        mitm_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        mitm_params
            .distinguished_name
            .push(DnType::CommonName, "Gateway MITM CA");
        mitm_params.not_before = OffsetDateTime::now_utc() - time::Duration::hours(1);
        mitm_params.not_after = OffsetDateTime::now_utc() + time::Duration::days(3650);
        let mitm_cert = mitm_params.self_signed(&mitm_key).expect("self-sign mitm");
        let mitm_der = mitm_cert.der().clone();

        // A DIFFERENT certificate — different CN, serial, and validity window
        // (as a re-issued cert would be) — but signed with the SAME key pair.
        let mut reissued_params = CertificateParams::default();
        reissued_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        reissued_params
            .distinguished_name
            .push(DnType::CommonName, "Totally Unrelated Client CA");
        reissued_params.not_before = OffsetDateTime::now_utc() - time::Duration::hours(2);
        reissued_params.not_after = OffsetDateTime::now_utc() + time::Duration::days(30);
        let reissued_cert = reissued_params
            .self_signed(&mitm_key)
            .expect("self-sign reissued cert with the same key");

        // Sanity check: the two certs must NOT be byte-identical — otherwise
        // this test would exercise the same path as the whole-DER case above
        // and prove nothing new.
        assert_ne!(reissued_cert.der().as_ref(), mitm_der.as_ref());

        let (server_cert_pem, server_key_pem, _) = self_signed_server_cert();
        let err = MtlsConfig::from_parts(
            Some("10256"),
            Some(&server_cert_pem),
            Some(&server_key_pem),
            Some(&reissued_cert.pem()),
            &mitm_der,
            10255,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("GATEWAY_CLIENT_CA"));
        assert!(format!("{err:#}").contains("public"));
    }

    // ── pem_from_env / pem_from_value ────────────────────────────────────

    #[test]
    fn pem_from_value_empty_is_none() {
        assert_eq!(pem_from_value("X", "").unwrap(), None);
        assert_eq!(pem_from_value("X", "   ").unwrap(), None);
    }

    #[test]
    fn pem_from_value_inline_pem_passthrough() {
        // Leading/trailing whitespace around the value is trimmed (matching
        // ca.rs's `load_from_pem`), so assert against the trimmed form.
        let pem = "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n";
        assert_eq!(
            pem_from_value("X", pem).unwrap(),
            Some(pem.trim().to_string())
        );
    }

    #[test]
    fn pem_from_value_reads_path() {
        let mut file = tempfile::NamedTempFile::new().expect("tempfile");
        write!(file, "file-contents").expect("write");
        let path = file.path().to_str().unwrap();
        assert_eq!(
            pem_from_value("X", path).unwrap(),
            Some("file-contents".to_string())
        );
    }

    #[test]
    fn pem_from_value_bad_path_errs() {
        let err = pem_from_value("GATEWAY_TLS_CERT", "/no/such/file.pem").unwrap_err();
        assert!(format!("{err:#}").contains("GATEWAY_TLS_CERT"));
        assert!(format!("{err:#}").contains("/no/such/file.pem"));
    }

    #[test]
    fn pem_from_env_unset_is_none() {
        // A var name essentially guaranteed not to be set.
        assert_eq!(
            pem_from_env("GATEWAY_CA_TEST_DOES_NOT_EXIST_XYZ").unwrap(),
            None
        );
    }

    // ── load_client_ca_roots ──────────────────────────────────────────────

    #[test]
    fn load_client_ca_roots_empty_pem_errs() {
        assert!(load_client_ca_roots("").is_err());
    }

    #[test]
    fn load_client_ca_roots_garbage_errs() {
        assert!(load_client_ca_roots("not pem at all").is_err());
    }

    #[test]
    fn load_client_ca_roots_valid_pem_ok() {
        let ca = new_test_ca("Trusted Client CA");
        assert!(load_client_ca_roots(&ca.cert.pem()).is_ok());
    }

    // Sanity: not_after_unix reflects the certificate's actual expiry, so a
    // "certificate expires in ~1 day" leaf really does report a timestamp
    // roughly a day in the future (the verifier — not this field — is what
    // rejects expired certs; this just confirms the value is meaningful for
    // Phase 2 to eventually build on).
    #[tokio::test]
    async fn identity_not_after_matches_leaf_validity() {
        ensure_crypto_provider();
        let ca = new_test_ca("Trusted Client CA");
        let (cert_pem, key_pem) = sign_client_leaf(&ca, Some("agent-1"), &[], -1, 24);
        let (server_config, server_der) = test_server_setup(&ca.cert.pem());
        let client_config = test_client_config(&server_der, Some(&cert_pem), Some(&key_pem));

        let mut tls_stream = attempt_handshake(server_config, client_config)
            .await
            .expect("valid cert accepted");
        let identity = tls_stream
            .get_ref()
            .1
            .peer_certificates()
            .and_then(identity_from_peer_certs)
            .expect("identity extracted");

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        // Leaf expires ~24h from now; allow generous slack for test runtime.
        assert!(identity.not_after_unix > now);
        assert!(identity.not_after_unix < now + 25 * 3600);

        use tokio::io::AsyncWriteExt;
        let _ = tls_stream.shutdown().await;
    }
}
