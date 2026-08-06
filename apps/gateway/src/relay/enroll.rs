//! Client-certificate enrollment (and, via [`enroll`] again, renewal) for
//! the relay: generate a keypair + CSR, call the Node API's
//! `POST /v1/gateway/client-cert`, and assemble the resulting mTLS
//! `ClientConfig`.
//!
//! The private key generated here never leaves this process — only the CSR
//! (proof of possession of the matching public key) is submitted. See
//! `client_ca_authority.rs`'s `ClientCa::sign_csr` on the gateway side for
//! the matching guarantee: every identity-bearing field on the certificate
//! that comes back is assigned server-side, not read from the CSR.

use std::sync::Arc;

use anyhow::{bail, Context, Result};
use rcgen::{CertificateParams, KeyPair, PKCS_ECDSA_P256_SHA256};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::ClientConfig;
use serde::{Deserialize, Serialize};

use crate::client_ca::load_client_ca_roots;

/// Generate a fresh ECDSA P-256 keypair and a CSR for it.
///
/// The CSR's subject/SAN fields are cosmetic — whatever `sign_csr` sees
/// there is discarded in full (see its own SECURITY note); this CSR exists
/// only to prove the relay holds the private key it's requesting a
/// certificate for.
pub(crate) fn generate_keypair_and_csr() -> Result<(KeyPair, String)> {
    let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256)
        .context("generating relay client keypair")?;
    let params = CertificateParams::default();
    let csr = params
        .serialize_request(&key)
        .context("building relay client CSR")?;
    let csr_pem = csr.pem().context("encoding relay CSR as PEM")?;
    Ok((key, csr_pem))
}

/// `POST /v1/gateway/client-cert` JSON response body — camelCase, matching
/// the Node route in `packages/api/src/routes/gateway.ts`
/// (`clientCertRoutes`). Field names here are exactly what that handler
/// serializes: `identity`, `hostId`, `certPem`, `caPem`, `serial`,
/// `notAfter`.
#[derive(Debug, Deserialize)]
struct EnrollResponseBody {
    identity: String,
    #[serde(rename = "hostId")]
    host_id: String,
    #[serde(rename = "certPem")]
    cert_pem: String,
    #[serde(rename = "caPem")]
    ca_pem: String,
    serial: String,
    #[serde(rename = "notAfter")]
    not_after_unix: i64,
}

/// A successful enrollment (or renewal) result.
#[derive(Debug, Clone)]
pub(crate) struct EnrollResponse {
    pub(crate) identity: String,
    pub(crate) host_id: String,
    /// Leaf + client-CA chain PEM — the relay's own certificate.
    pub(crate) cert_pem: String,
    /// The CLIENT CA that signed `cert_pem` — NOT the trust anchor for the
    /// remote gateway's server certificate. Deliberately unused for TLS
    /// verification anywhere in this module: see the SECURITY note on
    /// [`build_client_tls_config`] below. Kept only because it's part of the
    /// API response shape; a caller that wants to display/log it can.
    #[allow(dead_code)]
    pub(crate) ca_pem: String,
    pub(crate) serial: String,
    pub(crate) not_after_unix: i64,
}

/// Request body for `POST /v1/gateway/client-cert` — mirrors
/// `clientCertEnrollSchema` (`packages/api/src/validations/client-cert.ts`)
/// field-for-field, `.strict()` there means an extra field here would 400,
/// so this struct carries exactly `csrPem`/`label`/`hostId` and nothing
/// resembling key material.
#[derive(Debug, Serialize)]
struct EnrollRequestBody<'a> {
    #[serde(rename = "csrPem")]
    csr_pem: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<&'a str>,
    #[serde(rename = "hostId", skip_serializing_if = "Option::is_none")]
    host_id: Option<&'a str>,
}

/// Enroll (`host_id: None`) or renew (`host_id: Some(existing)`) via
/// `POST {api_url}/v1/gateway/client-cert`, authenticated as
/// `Authorization: Bearer {api_key}` (a project-scoped `oc_` key — the same
/// session-or-API-key `authMiddleware` every other project-scoped Node route
/// uses).
///
/// Passing the SAME `host_id` back on renewal is what makes the Node route's
/// `ensureClientHost` re-mint against the same `ClientHost` row/identity
/// instead of accumulating a new one per renewal.
pub(crate) async fn enroll(
    api_url: &str,
    api_key: &str,
    csr_pem: &str,
    host_id: Option<String>,
    label: Option<String>,
) -> Result<EnrollResponse> {
    let url = format!("{}/v1/gateway/client-cert", api_url.trim_end_matches('/'));
    let body = EnrollRequestBody {
        csr_pem,
        label: label.as_deref(),
        host_id: host_id.as_deref(),
    };

    let response = reqwest::Client::new()
        .post(&url)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .context("calling the gateway client-cert enrollment endpoint")?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        bail!("client-cert enrollment failed: HTTP {status}: {text}");
    }

    let parsed: EnrollResponseBody = response
        .json()
        .await
        .context("parsing client-cert enrollment response")?;

    Ok(EnrollResponse {
        identity: parsed.identity,
        host_id: parsed.host_id,
        cert_pem: parsed.cert_pem,
        ca_pem: parsed.ca_pem,
        serial: parsed.serial,
        not_after_unix: parsed.not_after_unix,
    })
}

fn pem_to_der_certs(pem: &str) -> Result<Vec<CertificateDer<'static>>> {
    let mut reader = pem.as_bytes();
    let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut reader)
        .collect::<Result<_, _>>()
        .context("parsing relay client certificate PEM")?;
    if certs.is_empty() {
        bail!("no certificates found in relay client certificate PEM");
    }
    Ok(certs)
}

/// Build the relay's mTLS `ClientConfig`.
///
/// SECURITY: `server_ca_pem` is `--gateway-server-ca` — the trust anchor for
/// the REMOTE GATEWAY'S SERVER certificate. It is NOT
/// [`EnrollResponse::ca_pem`], which is the CLIENT CA that signed `cert_pem`
/// and is irrelevant here: the relay never verifies its own certificate.
/// Confusing the two would mean either verifying the server against the
/// wrong anchor (server-cert verification would then fail against a real
/// gateway) or, worse, silently trusting whatever the enrollment response
/// happened to name as a server. This function only ever reads from the
/// `server_ca_pem` parameter for the root store — never from any field of
/// an [`EnrollResponse`].
pub(crate) fn build_client_tls_config(
    cert_pem: &str,
    key_pem: &str,
    server_ca_pem: &str,
) -> Result<Arc<ClientConfig>> {
    let roots = load_client_ca_roots(server_ca_pem).context("RELAY_GATEWAY_SERVER_CA")?;

    let cert_chain = pem_to_der_certs(cert_pem)?;
    let mut key_reader = key_pem.as_bytes();
    let key: PrivateKeyDer<'static> = rustls_pemfile::private_key(&mut key_reader)
        .context("parsing relay client private key")?
        .context("no private key found for the relay's client certificate")?;

    let mut config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_client_auth_cert(cert_chain, key)
        .context("building relay mTLS ClientConfig")?;
    // The gateway's mTLS listener pins http/1.1 (see `client_ca.rs`'s
    // `build_server_config`); match it here so ALPN negotiation can't drift.
    config.alpn_protocols = vec![b"http/1.1".to_vec()];

    Ok(Arc::new(config))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client_ca::test_support::{ensure_crypto_provider, new_test_ca, sign_client_leaf};

    #[test]
    fn generate_keypair_and_csr_produces_a_parseable_csr() {
        let (_key, csr_pem) = generate_keypair_and_csr().expect("csr");
        assert!(csr_pem.contains("BEGIN CERTIFICATE REQUEST"));
    }

    #[test]
    fn build_client_tls_config_errs_on_garbage_server_ca() {
        ensure_crypto_provider();
        let ca = new_test_ca("Test Client CA");
        let (cert_pem, key_pem) = sign_client_leaf(&ca, Some("relay"), &[], -1, 24);

        let err = build_client_tls_config(&cert_pem, &key_pem, "not a pem at all").unwrap_err();
        assert!(format!("{err:#}").contains("RELAY_GATEWAY_SERVER_CA"));
    }

    #[test]
    fn build_client_tls_config_errs_on_empty_server_ca() {
        ensure_crypto_provider();
        let ca = new_test_ca("Test Client CA");
        let (cert_pem, key_pem) = sign_client_leaf(&ca, Some("relay"), &[], -1, 24);

        let err = build_client_tls_config(&cert_pem, &key_pem, "").unwrap_err();
        assert!(format!("{err:#}").contains("RELAY_GATEWAY_SERVER_CA"));
    }

    #[test]
    fn build_client_tls_config_errs_on_garbage_client_cert() {
        ensure_crypto_provider();
        let ca = new_test_ca("Server Trust Anchor");
        let err = build_client_tls_config("not a cert", "not a key", &ca.cert.pem()).unwrap_err();
        assert!(!err.to_string().is_empty());
    }

    #[test]
    fn build_client_tls_config_succeeds_with_valid_material() {
        ensure_crypto_provider();
        let server_ca = new_test_ca("Server Trust Anchor");
        let client_ca = new_test_ca("Client Issuer");
        let (cert_pem, key_pem) = sign_client_leaf(
            &client_ca,
            Some("relay-1"),
            &["spiffe://onecli/relay/1"],
            -1,
            24,
        );

        let config = build_client_tls_config(&cert_pem, &key_pem, &server_ca.cert.pem())
            .expect("valid material must build a config");
        assert_eq!(config.alpn_protocols, vec![b"http/1.1".to_vec()]);
    }

    /// The enrollment call authenticates with `Authorization: Bearer
    /// {api_key}`, POSTs to `/v1/gateway/client-cert`, and parses the
    /// Node route's camelCase response shape into `EnrollResponse`.
    #[tokio::test]
    async fn enroll_posts_bearer_auth_and_parses_the_camelcase_response() {
        ensure_crypto_provider();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");

        let handle = std::thread::spawn(move || {
            use std::io::{Read, Write};
            let (mut stream, _) = listener.accept().expect("accept");
            let mut buf = [0u8; 8192];
            let n = stream.read(&mut buf).unwrap_or(0);
            let request = String::from_utf8_lossy(&buf[..n]).to_string();

            let body = concat!(
                "{\"identity\":\"spiffe://onecli/host/abc\",",
                "\"hostId\":\"abc\",",
                "\"certPem\":\"LEAF-AND-CA-PEM\",",
                "\"caPem\":\"CA-ONLY-PEM\",",
                "\"serial\":\"1a2b3c\",",
                "\"notAfter\":1893456000}"
            );
            let resp = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(resp.as_bytes());
            request
        });

        let result = enroll(
            &format!("http://{addr}"),
            "oc_test_key",
            "-----BEGIN CERTIFICATE REQUEST-----\nabc\n-----END CERTIFICATE REQUEST-----\n",
            None,
            Some("relay-1".to_string()),
        )
        .await
        .expect("enroll succeeds");

        let request = handle.join().expect("server thread");
        assert!(request.starts_with("POST /v1/gateway/client-cert"));
        assert!(
            request
                .to_lowercase()
                .contains("authorization: bearer oc_test_key"),
            "request must carry the Bearer api key: {request}"
        );
        assert!(request.contains("\"label\":\"relay-1\""));
        assert!(
            !request.contains("hostId"),
            "first enrollment must omit hostId"
        );

        assert_eq!(result.identity, "spiffe://onecli/host/abc");
        assert_eq!(result.host_id, "abc");
        assert_eq!(result.cert_pem, "LEAF-AND-CA-PEM");
        assert_eq!(result.ca_pem, "CA-ONLY-PEM");
        assert_eq!(result.serial, "1a2b3c");
        assert_eq!(result.not_after_unix, 1893456000);
    }

    #[tokio::test]
    async fn enroll_sends_host_id_on_renewal() {
        ensure_crypto_provider();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");

        let handle = std::thread::spawn(move || {
            use std::io::{Read, Write};
            let (mut stream, _) = listener.accept().expect("accept");
            let mut buf = [0u8; 8192];
            let n = stream.read(&mut buf).unwrap_or(0);
            let request = String::from_utf8_lossy(&buf[..n]).to_string();
            let body = concat!(
                "{\"identity\":\"spiffe://onecli/host/abc\",",
                "\"hostId\":\"abc\",",
                "\"certPem\":\"LEAF2\",",
                "\"caPem\":\"CA\",",
                "\"serial\":\"deadbeef\",",
                "\"notAfter\":1893456000}"
            );
            let resp = format!(
                "HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(resp.as_bytes());
            request
        });

        enroll(
            &format!("http://{addr}"),
            "oc_test",
            "csr-pem",
            Some("abc".to_string()),
            None,
        )
        .await
        .expect("renewal succeeds");

        let request = handle.join().expect("server thread");
        assert!(request.contains("\"hostId\":\"abc\""));
    }

    #[tokio::test]
    async fn enroll_errs_on_non_success_status() {
        ensure_crypto_provider();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");

        std::thread::spawn(move || {
            use std::io::{Read, Write};
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let body = "{\"error\":\"invalid CSR\"}";
                let resp = format!(
                    "HTTP/1.1 400 Bad Request\r\ncontent-length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes());
            }
        });

        let err = enroll(&format!("http://{addr}"), "oc_test", "csr-pem", None, None)
            .await
            .unwrap_err();
        assert!(format!("{err:#}").contains("400"));
    }

    #[tokio::test]
    async fn enroll_errs_when_unreachable() {
        ensure_crypto_provider();
        // Port 1 (tcpmux) is essentially guaranteed unbound in test
        // environments — an immediate connection refusal, not a hang.
        let err = enroll("http://127.0.0.1:1", "oc_test", "csr-pem", None, None)
            .await
            .unwrap_err();
        assert!(format!("{err:#}").contains("enrollment"));
    }
}
