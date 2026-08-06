//! Client-certificate CA: mints short-lived mTLS client certificates from a
//! CSR the Node API forwards on an agent's behalf.
//!
//! Lifecycle mirrors `ca.rs` exactly (env vars → disk → generate+persist,
//! 0600 key permissions, re-self-sign-on-load so `signed_by` has a
//! `Certificate` issuer to reference). What's new here is [`ClientCa::sign_csr`]
//! and the invariant it enforces — see the `SECURITY` note on that function.
//!
//! Declared unconditionally in `main.rs` (like `ca.rs`) so the OSS build
//! always compiles this module; whether it's ever exercised depends on
//! whether `GatewayState.client_ca` is `Some` (see `gateway.rs`).

use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};
use rcgen::{
    BasicConstraints, CertificateParams, CertificateSigningRequestParams, DistinguishedName,
    DnType, ExtendedKeyUsagePurpose, Ia5String, IsCa, KeyPair, KeyUsagePurpose, SanType,
    PKCS_ECDSA_P256_SHA256,
};
use rustls::pki_types::CertificateDer;
use time::OffsetDateTime;
use tokio::fs;
use tracing::info;

/// Client-CA certificate validity: 10 years (mirrors `ca.rs::CA_VALIDITY_DAYS`).
const CA_VALIDITY_DAYS: i64 = 3650;

/// CN for the generated client CA (distinct from `ca.rs`'s MITM CA CN — the
/// two must never be confused, see the SPKI guard in `client_ca.rs`).
const CLIENT_CA_CN: &str = "OneCLI Client CA";

/// Default issued-certificate lifetime when the caller doesn't ask for one.
pub(crate) const DEFAULT_LIFETIME: Duration = Duration::from_secs(24 * 3600);

/// Hard ceiling on issued-certificate lifetime, regardless of what's requested.
pub(crate) const MAX_LIFETIME: Duration = Duration::from_secs(7 * 24 * 3600);

/// Clamp a caller-requested lifetime (in seconds) to `(0, MAX_LIFETIME]`,
/// defaulting to `DEFAULT_LIFETIME` when unspecified or zero. Shared by the
/// gateway's internal HTTP handler so the policy lives in one place next to
/// the constants it enforces.
pub(crate) fn clamp_lifetime(requested_secs: Option<u64>) -> Duration {
    match requested_secs {
        None | Some(0) => DEFAULT_LIFETIME,
        Some(secs) => Duration::from_secs(secs).min(MAX_LIFETIME),
    }
}

/// A minted client certificate. Deliberately carries no private key material —
/// `sign_csr` never generates or sees one; the CSR is proof the caller already
/// holds the key it's requesting a certificate for.
#[derive(Debug)]
pub(crate) struct IssuedCert {
    /// PEM chain: the signed leaf, followed by this CA's own certificate.
    pub(crate) cert_pem: String,
    pub(crate) serial_hex: String,
    pub(crate) not_after_unix: i64,
}

/// Why [`ClientCa::sign_csr`] failed. `BadCsr` is caller error (maps to HTTP
/// 400 in `gateway.rs`); `Sign` is this CA's own failure (maps to a 500-class
/// response) and should not happen against a healthy CA + a CSR that already
/// parsed.
#[derive(Debug)]
pub(crate) enum SignCsrError {
    /// The CSR failed to parse, or its embedded signature failed to verify —
    /// garbage input, a tampered CSR, or an algorithm rcgen/x509-parser
    /// doesn't support. Never a panic: every rcgen parse error lands here.
    BadCsr(String),
    /// Something failed on our side while building/signing the fresh
    /// certificate (e.g. `spiffe_uri` not representable as IA5, or rcgen
    /// signing itself failing).
    Sign(anyhow::Error),
}

impl std::fmt::Display for SignCsrError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadCsr(msg) => write!(f, "invalid CSR: {msg}"),
            Self::Sign(err) => write!(f, "signing failed: {err:#}"),
        }
    }
}

impl std::error::Error for SignCsrError {}

/// The client-certificate CA: holds the key pair that signs every minted
/// client leaf, plus the certificate agents must trust as the mTLS anchor.
pub(crate) struct ClientCa {
    /// Re-created (same key + params) so `signed_by` has an issuer to
    /// reference — see `load_from_disk`'s doc comment on `ca.rs`'s twin.
    ca_cert: rcgen::Certificate,
    ca_key: KeyPair,
    /// The original CA certificate DER — served to callers via
    /// `ca_cert_pem()` and appended to every issued leaf's chain.
    ca_cert_der: CertificateDer<'static>,
}

impl ClientCa {
    /// Load an existing client CA from environment variables, disk, or
    /// generate a new one. Priority (identical shape to
    /// `ca::CertificateAuthority::load_or_generate`):
    ///
    /// 1. `GATEWAY_CLIENT_CA_KEY` + `GATEWAY_CLIENT_CA_CERT` env vars (cloud:
    ///    injected from Secrets Manager).
    /// 2. Files at `{data_dir}/gateway/client-ca.key` and `client-ca.pem`
    ///    (OSS: persisted on disk).
    /// 3. Generate a new client CA and persist to disk (OSS: first startup).
    ///
    /// Any failure here must abort startup (see `main.rs`) — never fall back
    /// to running with no minting capability while pretending to have one.
    pub(crate) async fn load_or_generate(data_dir: &Path) -> Result<Self> {
        if let (Ok(key_pem), Ok(cert_pem)) = (
            std::env::var("GATEWAY_CLIENT_CA_KEY"),
            std::env::var("GATEWAY_CLIENT_CA_CERT"),
        ) {
            if !key_pem.is_empty() && !cert_pem.is_empty() {
                info!("loading client CA from environment variables");
                return Self::load_from_pem(&key_pem, &cert_pem);
            }
        }

        let gateway_dir = data_dir.join("gateway");
        let key_path = gateway_dir.join("client-ca.key");
        let cert_path = gateway_dir.join("client-ca.pem");

        if key_path.exists() && cert_path.exists() {
            info!(
                key = %key_path.display(),
                cert = %cert_path.display(),
                "loading existing client CA"
            );
            Self::load_from_disk(&key_path, &cert_path).await
        } else {
            info!(dir = %gateway_dir.display(), "generating new client CA");
            fs::create_dir_all(&gateway_dir)
                .await
                .context("creating gateway data directory")?;
            Self::generate_and_persist(&key_path, &cert_path).await
        }
    }

    /// The client CA certificate as PEM — the trust anchor agents (and, when
    /// `GATEWAY_CLIENT_CA` is unset, the gateway's own mTLS listener) need.
    pub(crate) fn ca_cert_pem(&self) -> String {
        der_to_pem(self.ca_cert_der.as_ref())
    }

    /// The raw CA certificate DER.
    #[allow(dead_code)]
    pub(crate) fn ca_cert_der(&self) -> &CertificateDer<'static> {
        &self.ca_cert_der
    }

    /// Mint a client certificate for `host_id`/`spiffe_uri` from a CSR that
    /// already proves possession of the private key it names.
    ///
    /// SECURITY: this function uses ONLY the CSR's public key.
    /// `CertificateSigningRequestParams::from_pem` parses AND verifies the
    /// CSR's own signature (proof the caller holds the matching private
    /// key) — that's the full extent of what the CSR is trusted for. Its
    /// `params` field (the CSR's requested subject, SANs, extended/key
    /// usage, validity, and CA flag) is 100% attacker-controlled and is
    /// discarded in full below, never read again. Every identity-bearing
    /// field on the certificate actually issued is set HERE, server-side,
    /// from `host_id`/`spiffe_uri` alone.
    ///
    /// Do NOT replace the `signed_by` call below with
    /// `CertificateSigningRequestParams::signed_by` — that method copies the
    /// CSR's own subject/SAN/EKU onto the issued certificate (confirmed
    /// against rcgen 0.13.2 source), which would let any client mint a
    /// certificate for whatever identity it chooses. A client must never be
    /// able to choose its own identity.
    pub(crate) fn sign_csr(
        &self,
        host_id: &str,
        spiffe_uri: &str,
        csr_pem: &str,
        lifetime: Duration,
    ) -> Result<IssuedCert, SignCsrError> {
        // SECURITY: the client's proof of key-possession is entirely
        // `from_pem`'s job — it parses the CSR AND verifies its embedded
        // self-signature (rcgen 0.13.2, gated behind the `x509-parser`
        // feature this crate turns on in Cargo.toml). Garbage, tampered, or
        // an unsupported signature algorithm all fail here as a plain `Err`,
        // never a panic — see `sign_csr_tampered_csr_body_byte_is_rejected`
        // and the malformed/garbage/unsupported-algorithm tests below. That
        // suite is the REAL guard against a silent regression here (e.g. an
        // rcgen upgrade/downgrade that weakens or drops the signature check)
        // — no hard version pin is needed beyond Cargo.lock's normal pinning
        // of the resolved version, because these tests would start failing
        // immediately if possession verification ever stopped happening.
        let CertificateSigningRequestParams {
            public_key,
            // SECURITY: named (not `_`) and never referenced again, so a
            // future edit that starts reading it is a visible diff, not a
            // silent regression. This is the CSR's attacker-controlled
            // subject/SAN/EKU/key-usage/validity/is_ca — discarded whole.
            params: _csr_params_discarded_do_not_use,
        } = CertificateSigningRequestParams::from_pem(csr_pem)
            .map_err(|e| SignCsrError::BadCsr(e.to_string()))?;

        let uri_san = Ia5String::try_from(spiffe_uri.to_string())
            .map_err(|e| SignCsrError::Sign(anyhow::anyhow!("spiffe_uri is not IA5: {e}")))?;

        let mut distinguished_name = DistinguishedName::new();
        distinguished_name.push(DnType::CommonName, host_id);

        let mut params = CertificateParams::default();
        params.subject_alt_names = vec![SanType::URI(uri_san)];
        params.distinguished_name = distinguished_name;
        // Explicit, even though `CertificateParams::default()` already gives
        // `IsCa::NoCa` — a client certificate must never be a CA, and that
        // must never be something we forward from the CSR (see the SECURITY
        // note above).
        params.is_ca = IsCa::NoCa;
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
        params.use_authority_key_identifier_extension = true;
        // Small backdate for clock skew, mirroring `ca.rs::leaf_params`.
        params.not_before = OffsetDateTime::now_utc() - time::Duration::minutes(5);
        params.not_after =
            OffsetDateTime::now_utc() + time::Duration::seconds(lifetime.as_secs() as i64);

        let leaf_cert = params
            .signed_by(&public_key, &self.ca_cert, &self.ca_key)
            .map_err(|e| SignCsrError::Sign(anyhow::anyhow!("signing client certificate: {e}")))?;

        let (_, parsed) = x509_parser::parse_x509_certificate(leaf_cert.der().as_ref())
            .map_err(|e| SignCsrError::Sign(anyhow::anyhow!("parsing freshly signed leaf: {e}")))?;
        let serial_hex = hex::encode(parsed.raw_serial());
        let not_after_unix = parsed.validity().not_after.timestamp();

        // Chain: leaf + this CA's certificate, so a peer that only trusts the
        // CA (not every intermediate) can still build the path.
        let cert_pem = format!("{}{}", leaf_cert.pem(), self.ca_cert_pem());

        Ok(IssuedCert {
            cert_pem,
            serial_hex,
            not_after_unix,
        })
    }

    // ── Private ──────────────────────────────────────────────────────────

    fn build_ca_params() -> CertificateParams {
        let mut params = CertificateParams::default();
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params
            .distinguished_name
            .push(DnType::CommonName, CLIENT_CA_CN);
        params
            .distinguished_name
            .push(DnType::OrganizationName, "OneCLI");
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        params.not_before = OffsetDateTime::now_utc();
        params.not_after = OffsetDateTime::now_utc() + time::Duration::days(CA_VALIDITY_DAYS);
        params
    }

    /// Load a client CA supplied by an operator (`GATEWAY_CLIENT_CA_KEY` +
    /// `GATEWAY_CLIENT_CA_CERT`), which — unlike our own generated/persisted
    /// CA — can carry ANY subject DN the operator's own PKI chose.
    ///
    /// NIT fix: this used to re-create the issuer via
    /// `Self::build_ca_params()` (our own hardcoded `CLIENT_CA_CN`), which
    /// only happens to work when the operator's cert's subject DN matches
    /// that hardcoded value. `signed_by`'s `Issuer` only reads
    /// `distinguished_name`/`key_identifier_method`/`key_usages` off the
    /// `Certificate` passed in — it never reads `ca_cert_der` for that — so
    /// a mismatch would silently mint leaves whose `issuer` field doesn't
    /// match the actually-served trust anchor's `subject`: chain building
    /// against the real anchor fails (fails closed, but confusingly, since
    /// nothing here would say why). Deriving `CertificateParams` straight
    /// from the loaded DER via `from_ca_cert_der` (rcgen's own tool for
    /// exactly this "sign with an existing external CA" case) makes the
    /// issuer DN always match the served cert, whatever DN it carries.
    fn load_from_pem(key_pem: &str, cert_pem: &str) -> Result<Self> {
        let key_pem = key_pem.trim();
        let cert_pem = cert_pem.trim();
        let ca_key =
            KeyPair::from_pem(key_pem).context("parsing client CA private key from env var")?;

        let mut reader = cert_pem.as_bytes();
        let ca_cert_der = rustls_pemfile::certs(&mut reader)
            .next()
            .context("no certificate found in GATEWAY_CLIENT_CA_CERT env var")?
            .context("parsing client CA certificate PEM from env var")?;

        let ca_cert = CertificateParams::from_ca_cert_der(&ca_cert_der)
            .context(
                "parsing GATEWAY_CLIENT_CA_CERT to extract its subject DN and issuer parameters",
            )?
            .self_signed(&ca_key)
            .context(
                "re-creating the loaded client CA certificate for signing (does the private \
                 key in GATEWAY_CLIENT_CA_KEY match the certificate in GATEWAY_CLIENT_CA_CERT?)",
            )?;

        Ok(Self {
            ca_cert,
            ca_key,
            ca_cert_der,
        })
    }

    async fn generate_and_persist(key_path: &Path, cert_path: &Path) -> Result<Self> {
        let ca_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256)
            .context("generating client CA key pair")?;
        let params = Self::build_ca_params();
        let ca_cert = params
            .self_signed(&ca_key)
            .context("self-signing client CA certificate")?;
        let ca_cert_der = ca_cert.der().clone();

        let key_pem = ca_key.serialize_pem();
        fs::write(key_path, key_pem.as_bytes())
            .await
            .context("writing client CA private key")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(key_path, std::fs::Permissions::from_mode(0o600)).ok();
        }

        let cert_pem = der_to_pem(ca_cert_der.as_ref());
        fs::write(cert_path, cert_pem.as_bytes())
            .await
            .context("writing client CA certificate")?;

        info!(
            cn = CLIENT_CA_CN,
            key = %key_path.display(),
            cert = %cert_path.display(),
            "generated and persisted new client CA"
        );

        Ok(Self {
            ca_cert,
            ca_key,
            ca_cert_der,
        })
    }

    /// Load an existing client CA from disk. Same re-creation trick as
    /// `ca::CertificateAuthority::load_from_disk`: `signed_by` needs a
    /// `Certificate` issuer reference, and the only way to get one is
    /// `self_signed()`/`signed_by()` — so re-self-sign with the same key +
    /// params. The issuer DN in minted leaves matches the on-disk cert
    /// because the params are identical; the on-disk DER (not this
    /// re-creation) is what's served and chained.
    async fn load_from_disk(key_path: &Path, cert_path: &Path) -> Result<Self> {
        let key_pem = fs::read_to_string(key_path)
            .await
            .context("reading client CA private key")?;
        let ca_key = KeyPair::from_pem(&key_pem).context("parsing client CA private key")?;

        let cert_pem = fs::read_to_string(cert_path)
            .await
            .context("reading client CA certificate")?;
        let mut reader = cert_pem.as_bytes();
        let ca_cert_der = rustls_pemfile::certs(&mut reader)
            .next()
            .context("no certificate found in client CA PEM file")?
            .context("parsing client CA certificate PEM")?;

        let ca_cert = Self::build_ca_params()
            .self_signed(&ca_key)
            .context("re-creating client CA certificate for signing")?;

        info!("loaded existing client CA certificate");

        Ok(Self {
            ca_cert,
            ca_key,
            ca_cert_der,
        })
    }
}

/// Encode raw DER bytes as a PEM-formatted certificate string. Duplicated
/// from `ca.rs` (private there) rather than shared — each CA module in this
/// crate owns its own small PEM helpers (see also `client_ca.rs`'s
/// `pem_to_der_certs`).
fn der_to_pem(der: &[u8]) -> String {
    let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, der);
    let num_lines = b64.len().div_ceil(64);
    let capacity = 28 + b64.len() + num_lines + 26;
    let mut pem = String::with_capacity(capacity);
    pem.push_str("-----BEGIN CERTIFICATE-----\n");
    for chunk in b64.as_bytes().chunks(64) {
        pem.push_str(std::str::from_utf8(chunk).expect("base64 is valid utf8"));
        pem.push('\n');
    }
    pem.push_str("-----END CERTIFICATE-----\n");
    pem
}

/// Encode raw CSR DER bytes as a PEM-formatted CSR string — the inverse of
/// `rustls_pemfile::csr`, used by `#[cfg(test)]` code that mutates a CSR's
/// DER and needs to feed it back through `sign_csr` as PEM.
#[cfg(test)]
fn csr_der_to_pem(der: &[u8]) -> String {
    let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, der);
    let mut pem = String::new();
    pem.push_str("-----BEGIN CERTIFICATE REQUEST-----\n");
    for chunk in b64.as_bytes().chunks(64) {
        pem.push_str(std::str::from_utf8(chunk).expect("base64 is valid utf8"));
        pem.push('\n');
    }
    pem.push_str("-----END CERTIFICATE REQUEST-----\n");
    pem
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::client_ca::identity_from_peer_certs;
    use crate::client_ca::test_support::{
        attempt_handshake, ensure_crypto_provider, err_debug_contains, new_test_ca,
        test_client_config, test_server_setup,
    };

    /// Build a CSR PEM for `key`, optionally embedding attacker-requested
    /// identity fields (CN/URI SAN) that a correct `sign_csr` must ignore.
    /// Mirrors the rcgen 0.13.2 facts: `CertificateParams::serialize_request`
    /// produces the CSR PEM directly from params + key.
    fn build_csr_pem(
        key: &KeyPair,
        requested_cn: Option<&str>,
        requested_uri: Option<&str>,
    ) -> String {
        let mut params = CertificateParams::default();
        if let Some(cn) = requested_cn {
            params.distinguished_name = DistinguishedName::new();
            params.distinguished_name.push(DnType::CommonName, cn);
        }
        if let Some(uri) = requested_uri {
            params.subject_alt_names = vec![SanType::URI(
                Ia5String::try_from(uri.to_string()).expect("ia5"),
            )];
        }
        let csr = params.serialize_request(key).expect("build CSR");
        csr.pem().expect("CSR PEM")
    }

    fn new_client_ca() -> ClientCa {
        let ca_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("ca key");
        let params = ClientCa::build_ca_params();
        let ca_cert = params.self_signed(&ca_key).expect("self-sign client ca");
        let ca_cert_der = ca_cert.der().clone();
        ClientCa {
            ca_cert,
            ca_key,
            ca_cert_der,
        }
    }

    // ── clamp_lifetime ───────────────────────────────────────────────────

    #[test]
    fn clamp_lifetime_none_is_default() {
        assert_eq!(clamp_lifetime(None), DEFAULT_LIFETIME);
    }

    #[test]
    fn clamp_lifetime_zero_is_default() {
        assert_eq!(clamp_lifetime(Some(0)), DEFAULT_LIFETIME);
    }

    #[test]
    fn clamp_lifetime_within_range_passes_through() {
        assert_eq!(clamp_lifetime(Some(3600)), Duration::from_secs(3600));
    }

    #[test]
    fn clamp_lifetime_above_max_is_clamped() {
        assert_eq!(
            clamp_lifetime(Some(MAX_LIFETIME.as_secs() + 1000)),
            MAX_LIFETIME
        );
    }

    // ── sign_csr: happy path + end-to-end verification ──────────────────

    #[tokio::test]
    async fn sign_csr_happy_path_verifies_through_webpki_and_carries_server_identity() {
        ensure_crypto_provider();
        let ca = new_client_ca();

        let client_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("client key");
        let csr_pem = build_csr_pem(&client_key, None, None);

        let issued = ca
            .sign_csr(
                "host-42",
                "spiffe://onecli/host/42",
                &csr_pem,
                Duration::from_secs(3600),
            )
            .expect("sign_csr succeeds");

        assert!(!issued.serial_hex.is_empty());
        assert!(issued.not_after_unix > 0);
        // Leaf, then CA — both PEM blocks present in the chain.
        assert_eq!(issued.cert_pem.matches("BEGIN CERTIFICATE").count(), 2);

        // The chain must actually verify through Phase 1's client verifier —
        // reusing the exact harness `client_ca.rs`'s own tests run against.
        let (server_config, server_der) = test_server_setup(&ca.ca_cert_pem());
        let leaf_pem = issued
            .cert_pem
            .split("-----END CERTIFICATE-----\n")
            .next()
            .map(|s| format!("{s}-----END CERTIFICATE-----\n"))
            .expect("leaf pem slice");
        let client_config = test_client_config(
            &server_der,
            Some(&leaf_pem),
            Some(&client_key.serialize_pem()),
        );

        let mut tls_stream = attempt_handshake(server_config, client_config)
            .await
            .expect("minted client cert must be accepted by the mTLS listener");

        let identity = tls_stream
            .get_ref()
            .1
            .peer_certificates()
            .and_then(identity_from_peer_certs)
            .expect("identity extracted from minted cert");
        assert_eq!(identity.primary(), Some("spiffe://onecli/host/42"));
        assert_eq!(identity.cn.as_deref(), Some("host-42"));

        use tokio::io::AsyncWriteExt;
        let _ = tls_stream.shutdown().await;
    }

    // ── CRITICAL: the CSR's requested identity must never survive ───────

    #[test]
    fn sign_csr_ignores_attacker_requested_identity_entirely() {
        ensure_crypto_provider();
        let ca = new_client_ca();

        let client_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("client key");
        // The CSR asks to BE someone else entirely.
        let csr_pem = build_csr_pem(
            &client_key,
            Some("attacker-impersonating-admin"),
            Some("spiffe://onecli/host/some-other-victim"),
        );

        let issued = ca
            .sign_csr(
                "real-host-id",
                "spiffe://onecli/host/real-host-id",
                &csr_pem,
                Duration::from_secs(3600),
            )
            .expect("sign_csr succeeds");

        // Parse the actual issued leaf's structured fields — NOT a substring
        // search on `cert_pem` (it's base64-encoded DER; the CSR's requested
        // strings wouldn't appear as literal text there either way, so that
        // would prove nothing). `certs()` on the combined chain yields the
        // leaf first.
        let mut reader = issued.cert_pem.as_bytes();
        let leaf_der = rustls_pemfile::certs(&mut reader)
            .next()
            .expect("leaf present")
            .expect("leaf parses");
        let (_, parsed) =
            x509_parser::parse_x509_certificate(leaf_der.as_ref()).expect("parse leaf");

        let cn = parsed
            .subject()
            .iter_common_name()
            .next()
            .and_then(|a| a.as_str().ok());
        assert_eq!(cn, Some("real-host-id"), "CN must be the server identity");
        assert_ne!(cn, Some("attacker-impersonating-admin"));

        let uri_sans: Vec<&str> = parsed
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
                    .collect()
            })
            .unwrap_or_default();
        assert_eq!(
            uri_sans,
            vec!["spiffe://onecli/host/real-host-id"],
            "the ONLY SAN must be the server-supplied spiffe URI"
        );
        assert!(!uri_sans.contains(&"spiffe://onecli/host/some-other-victim"));
    }

    // ── Malformed / tampered / unsupported CSRs → BadCsr, never a panic ─

    #[test]
    fn sign_csr_malformed_csr_is_bad_csr_not_panic() {
        ensure_crypto_provider();
        let ca = new_client_ca();

        let result = ca.sign_csr(
            "host",
            "spiffe://onecli/host/x",
            "not a csr at all",
            Duration::from_secs(60),
        );
        assert!(matches!(result, Err(SignCsrError::BadCsr(_))));
    }

    #[test]
    fn sign_csr_tampered_csr_body_byte_is_rejected() {
        ensure_crypto_provider();
        let ca = new_client_ca();

        let client_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("client key");
        let csr_pem = build_csr_pem(&client_key, None, None);

        // Flip one base64 character in the PEM body (not the header/footer) —
        // this corrupts the DER, which fails to parse or fails signature
        // verification, either way a `BadCsr`, never a panic.
        let mut lines: Vec<&str> = csr_pem.lines().collect();
        let body_idx = lines
            .iter()
            .position(|l| !l.starts_with("-----"))
            .expect("has a body line");
        let mut chars: Vec<char> = lines[body_idx].chars().collect();
        assert!(!chars.is_empty(), "body line must not be empty");
        chars[0] = if chars[0] == 'A' { 'B' } else { 'A' };
        let tampered_line: String = chars.into_iter().collect();
        lines[body_idx] = &tampered_line;
        let tampered_pem = lines.join("\n") + "\n";

        let result = ca.sign_csr(
            "host",
            "spiffe://onecli/host/x",
            &tampered_pem,
            Duration::from_secs(60),
        );
        assert!(matches!(result, Err(SignCsrError::BadCsr(_))));
    }

    /// An unrecognized/garbled signature-algorithm OID must fail gracefully
    /// (→ `BadCsr` → HTTP 400), never panic. Real-world unsupported-algorithm
    /// CSRs are the natural trigger for this path; this test reaches the
    /// same rcgen code path deterministically by corrupting the OID's last
    /// arc directly, length-preserving so the DER stays syntactically valid.
    ///
    /// This is a PROXY, not a literal foreign-algorithm CSR: every algorithm
    /// this crate's rcgen build can actually GENERATE a CSR with (ECDSA
    /// P-256/P-384/P-521, Ed25519 — RSA generation is unavailable without the
    /// `aws_lc_rs` feature, which isn't enabled) is one `SignatureAlgorithm::
    /// from_oid` recognizes, so there's no real key we can hand it that's
    /// genuinely unsupported. `sign_csr_accepts_a_genuine_ed25519_csr_and_the_leaf_verifies`
    /// below covers the one truly-different (non-ECDSA) algorithm we CAN
    /// build for real; this OID-mutation test is kept as the deterministic
    /// stand-in for "an algorithm neither rcgen nor x509-parser knows at all".
    #[test]
    fn sign_csr_unsupported_signature_algorithm_is_bad_csr_not_panic() {
        ensure_crypto_provider();
        let ca = new_client_ca();

        let client_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("client key");
        let csr_pem = build_csr_pem(&client_key, None, None);

        let mut reader = csr_pem.as_bytes();
        let der = rustls_pemfile::csr(&mut reader)
            .expect("read csr pem")
            .expect("csr present")
            .as_ref()
            .to_vec();

        // ecdsa-with-SHA256's OID content bytes (1.2.840.10045.4.3.2). This
        // 8-byte pattern is distinct from the 7-byte ecPublicKey OID
        // (1.2.840.10045.2.1) that also appears in the CSR's SPKI, so the
        // match below can only land on the outer signatureAlgorithm field.
        let target: [u8; 8] = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];
        let mut mutated = der.clone();
        let pos = mutated
            .windows(target.len())
            .position(|w| w == target)
            .expect("ecdsa-with-SHA256 OID present in CSR DER");
        mutated[pos + target.len() - 1] = 0x7f;

        let mutated_pem = csr_der_to_pem(&mutated);
        let result = ca.sign_csr(
            "host",
            "spiffe://onecli/host/x",
            &mutated_pem,
            Duration::from_secs(60),
        );
        assert!(
            matches!(result, Err(SignCsrError::BadCsr(_))),
            "an unsupported/garbled signature algorithm must fail as BadCsr, not panic: {result:?}"
        );
    }

    /// A GENUINE cross-algorithm CSR (not a proxy): an Ed25519 key, generated
    /// for real via `rcgen::PKCS_ED25519` (supported by the `ring` feature
    /// without any external key material, unlike RSA — see the comment on
    /// `sign_csr_unsupported_signature_algorithm_is_bad_csr_not_panic`
    /// above). Pins the ACTUAL behavior: this crate supports minting from a
    /// non-ECDSA CSR. The CA's own signing algorithm (ECDSA P-256) is
    /// independent of the subject key's algorithm — a CA never needs to
    /// share an algorithm with the certificates it signs — so the CSR
    /// parses, `signed_by` accepts the Ed25519 public key, and the resulting
    /// leaf (Ed25519 subject key + ECDSA-signed by the CA) verifies through
    /// the real `WebPkiClientVerifier`, including the TLS handshake's own
    /// Ed25519 `CertificateVerify` step.
    #[tokio::test]
    async fn sign_csr_accepts_a_genuine_ed25519_csr_and_the_leaf_verifies() {
        ensure_crypto_provider();
        let ca = new_client_ca();

        let client_key =
            KeyPair::generate_for(&rcgen::PKCS_ED25519).expect("generate Ed25519 client key");
        let csr_pem = build_csr_pem(&client_key, None, None);

        let issued = ca
            .sign_csr(
                "ed25519-host",
                "spiffe://onecli/host/ed25519",
                &csr_pem,
                Duration::from_secs(3600),
            )
            .expect("sign_csr must accept a genuine Ed25519 CSR, not just ECDSA ones");

        let (server_config, server_der) = test_server_setup(&ca.ca_cert_pem());
        let leaf_pem = issued
            .cert_pem
            .split("-----END CERTIFICATE-----\n")
            .next()
            .map(|s| format!("{s}-----END CERTIFICATE-----\n"))
            .expect("leaf slice");
        let client_config = test_client_config(
            &server_der,
            Some(&leaf_pem),
            Some(&client_key.serialize_pem()),
        );

        attempt_handshake(server_config, client_config)
            .await
            .expect("an Ed25519-keyed leaf, signed by our ECDSA CA, must verify end to end");
    }

    #[test]
    fn sign_csr_garbage_pem_wrapper_is_bad_csr() {
        ensure_crypto_provider();
        let ca = new_client_ca();

        let garbage_pem =
            "-----BEGIN CERTIFICATE REQUEST-----\nbm90IGEgcmVhbCBjc3I=\n-----END CERTIFICATE REQUEST-----\n";
        let result = ca.sign_csr(
            "host",
            "spiffe://onecli/host/x",
            garbage_pem,
            Duration::from_secs(60),
        );
        assert!(matches!(result, Err(SignCsrError::BadCsr(_))));
    }

    // ── IssuedCert never carries key material (structural guarantee) ────
    //
    // `IssuedCert` has exactly three fields — `cert_pem`, `serial_hex`,
    // `not_after_unix` — and this constructor is the only place one is built.
    // There is no field to leak a key through; this test exists so a future
    // edit that adds one has to touch this assertion.
    #[test]
    fn issued_cert_has_no_key_field() {
        ensure_crypto_provider();
        let ca = new_client_ca();
        let client_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("client key");
        let csr_pem = build_csr_pem(&client_key, None, None);
        let issued = ca
            .sign_csr(
                "host",
                "spiffe://onecli/host/x",
                &csr_pem,
                Duration::from_secs(60),
            )
            .expect("sign succeeds");
        let IssuedCert {
            cert_pem: _,
            serial_hex: _,
            not_after_unix: _,
        } = issued;
    }

    // ── Wrong-CA / expired leaves rejected through the real verifier ────

    #[tokio::test]
    async fn minted_leaf_rejected_when_verifier_trusts_a_different_ca() {
        ensure_crypto_provider();
        let ca = new_client_ca();
        let other_ca = new_test_ca("Some Other CA");

        let client_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("client key");
        let csr_pem = build_csr_pem(&client_key, None, None);
        let issued = ca
            .sign_csr(
                "host",
                "spiffe://onecli/host/x",
                &csr_pem,
                Duration::from_secs(3600),
            )
            .expect("sign succeeds");

        // The verifier trusts `other_ca`, NOT the CA that actually signed
        // this leaf.
        let (server_config, server_der) = test_server_setup(&other_ca.cert.pem());
        let leaf_pem = issued
            .cert_pem
            .split("-----END CERTIFICATE-----\n")
            .next()
            .map(|s| format!("{s}-----END CERTIFICATE-----\n"))
            .expect("leaf slice");
        let client_config = test_client_config(
            &server_der,
            Some(&leaf_pem),
            Some(&client_key.serialize_pem()),
        );

        let result = attempt_handshake(server_config, client_config).await;
        let err = result.expect_err("leaf signed by an untrusted CA must be rejected");
        assert!(
            err_debug_contains(&err, "UnknownIssuer"),
            "unexpected error: {err:?}"
        );
    }

    #[tokio::test]
    async fn minted_leaf_rejected_once_expired() {
        ensure_crypto_provider();
        let ca = new_client_ca();

        let client_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("client key");
        let csr_pem = build_csr_pem(&client_key, None, None);

        // `sign_csr` always backdates `not_before` 5 minutes and can't mint
        // an already-expired cert through its own API (by design — the
        // handler clamps to a positive lifetime). To test the verifier's
        // expiry check against a cert issued by THIS CA, build the expired
        // leaf directly with the CA's key, mirroring `sign_csr`'s own leaf
        // params but with a validity window entirely in the past.
        let CertificateSigningRequestParams { public_key, .. } =
            CertificateSigningRequestParams::from_pem(&csr_pem).expect("parse csr");
        let mut params = CertificateParams::default();
        params.subject_alt_names = vec![SanType::URI(
            Ia5String::try_from("spiffe://onecli/host/x".to_string()).unwrap(),
        )];
        params.distinguished_name.push(DnType::CommonName, "host");
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
        params.not_before = OffsetDateTime::now_utc() - time::Duration::hours(48);
        params.not_after = OffsetDateTime::now_utc() - time::Duration::hours(24);
        let expired_leaf = params
            .signed_by(&public_key, &ca.ca_cert, &ca.ca_key)
            .expect("sign expired leaf");

        let (server_config, server_der) = test_server_setup(&ca.ca_cert_pem());
        let client_config = test_client_config(
            &server_der,
            Some(&expired_leaf.pem()),
            Some(&client_key.serialize_pem()),
        );

        let result = attempt_handshake(server_config, client_config).await;
        let err = result.expect_err("expired leaf must be rejected");
        assert!(
            err_debug_contains(&err, "Expired"),
            "unexpected error: {err:?}"
        );
    }

    // ── Persistence: 0600 permissions, persist → reload → sign still works ─

    #[tokio::test]
    async fn client_ca_key_file_has_restricted_permissions() {
        let tmp = tempfile::tempdir().expect("tempdir");
        ClientCa::load_or_generate(tmp.path())
            .await
            .expect("generate");

        let key_path = tmp.path().join("gateway").join("client-ca.key");
        assert!(key_path.exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = std::fs::metadata(&key_path)
                .expect("metadata")
                .permissions();
            assert_eq!(perms.mode() & 0o777, 0o600);
        }
    }

    #[tokio::test]
    async fn client_ca_persists_and_reload_can_still_sign() {
        ensure_crypto_provider();
        let tmp = tempfile::tempdir().expect("tempdir");

        let ca1 = ClientCa::load_or_generate(tmp.path())
            .await
            .expect("generate");
        let ca2 = ClientCa::load_or_generate(tmp.path())
            .await
            .expect("reload");
        assert_eq!(ca1.ca_cert_pem(), ca2.ca_cert_pem());

        let client_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("client key");
        let csr_pem = build_csr_pem(&client_key, None, None);
        let issued = ca2
            .sign_csr(
                "host",
                "spiffe://onecli/host/x",
                &csr_pem,
                Duration::from_secs(3600),
            )
            .expect("sign after reload succeeds");

        let (server_config, server_der) = test_server_setup(&ca2.ca_cert_pem());
        let leaf_pem = issued
            .cert_pem
            .split("-----END CERTIFICATE-----\n")
            .next()
            .map(|s| format!("{s}-----END CERTIFICATE-----\n"))
            .expect("leaf slice");
        let client_config = test_client_config(
            &server_der,
            Some(&leaf_pem),
            Some(&client_key.serialize_pem()),
        );

        attempt_handshake(server_config, client_config)
            .await
            .expect("leaf signed after CA reload must verify");
    }

    // ── load_from_pem: issuer DN must come from the LOADED cert ──────────

    /// NIT fix regression guard: an operator-supplied `GATEWAY_CLIENT_CA_CERT`
    /// can carry any subject DN — nothing requires it to match this crate's
    /// hardcoded `CLIENT_CA_CN`. Before the fix, `load_from_pem` re-created
    /// the issuer via the hardcoded `build_ca_params()`, so a minted leaf's
    /// `issuer` field would silently mismatch the real trust anchor's
    /// `subject` whenever the operator's DN differed — failing chain
    /// validation with no clue why. This proves a leaf minted from an
    /// externally-supplied CA with a DIFFERENT DN still verifies through
    /// that SAME external CA's own certificate.
    #[tokio::test]
    async fn load_from_pem_derives_issuer_dn_from_the_loaded_cert_not_the_hardcoded_default() {
        ensure_crypto_provider();

        // Deliberately NOT "OneCLI Client CA" (this crate's CLIENT_CA_CN) —
        // an operator's own PKI, with its own naming.
        let external_ca = new_test_ca("Acme Corp Internal Root CA");
        let key_pem = external_ca.key.serialize_pem();
        let cert_pem = external_ca.cert.pem();

        let ca = ClientCa::load_from_pem(&key_pem, &cert_pem).expect("load external CA");
        // Sanity: the loaded CA really does serve back the operator's own
        // cert (with its own DN), not something we regenerated.
        assert_eq!(ca.ca_cert_pem(), external_ca.cert.pem());

        let client_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("client key");
        let csr_pem = build_csr_pem(&client_key, None, None);
        let issued = ca
            .sign_csr(
                "host",
                "spiffe://onecli/host/x",
                &csr_pem,
                Duration::from_secs(3600),
            )
            .expect("sign succeeds against an externally-supplied CA");

        // The minted leaf must chain through the ACTUAL external CA
        // certificate — this fails if the leaf's issuer DN doesn't match
        // that cert's real subject DN.
        let (server_config, server_der) = test_server_setup(&external_ca.cert.pem());
        let leaf_pem = issued
            .cert_pem
            .split("-----END CERTIFICATE-----\n")
            .next()
            .map(|s| format!("{s}-----END CERTIFICATE-----\n"))
            .expect("leaf slice");
        let client_config = test_client_config(
            &server_der,
            Some(&leaf_pem),
            Some(&client_key.serialize_pem()),
        );

        attempt_handshake(server_config, client_config)
            .await
            .expect(
                "a leaf minted against an externally-supplied CA with a non-default DN must still \
             verify through that CA's own certificate",
            );
    }
}
