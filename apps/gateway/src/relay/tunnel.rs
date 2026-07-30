//! The blind byte-splice itself.
//!
//! See `relay.rs`'s module doc for the full security rationale — the short
//! version: [`splice`] never reads the agent's bytes as HTTP. It dials the
//! remote gateway over mTLS and hands both sides to
//! [`tokio::io::copy_bidirectional`], so the agent's CONNECT line (or
//! absolute-form request) and every header it sent — including
//! `Proxy-Authorization` — reach the remote gateway exactly as written.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use arc_swap::ArcSwap;
use rustls::pki_types::ServerName;
use tokio::io::{copy_bidirectional, AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tracing::{debug, warn};

use super::RelayCertState;

/// Written to the agent, then the connection is closed, whenever the relay
/// cannot complete a tunnel to the remote gateway — an expired certificate,
/// a failed TCP dial, or a failed/rejected TLS handshake. NEVER followed by
/// a fall back to direct egress or plaintext forwarding: refusing is the
/// only other option.
const BAD_GATEWAY: &[u8] = b"HTTP/1.1 502 Bad Gateway\r\n\r\n";

/// How long [`drain_pending`] waits for a quiet period before giving up.
const DRAIN_QUIET_PERIOD: Duration = Duration::from_millis(20);

/// Ceiling on the TCP dial + mTLS handshake to the remote gateway. Without
/// this, a black-holed `gateway_addr` (packets dropped, never refused) hangs
/// the per-connection task — and therefore the agent's socket — forever;
/// per-connection tasks are deliberately untracked by shutdown (see
/// `relay.rs::run`), so nothing else would ever reclaim it. Elapsing this is
/// treated exactly like any other dial failure: fail closed with a `502`,
/// never a fallback.
const RELAY_DIAL_TIMEOUT: Duration = Duration::from_secs(10);

/// Best-effort: read (and discard, unparsed) whatever the agent has ALREADY
/// sent — its CONNECT line and headers, on the fail-closed paths below —
/// before we write an error response and close the connection.
///
/// This is not the "never read the agent's bytes" rule from [`splice`]'s
/// doc broken in spirit: on these paths the bytes are never forwarded
/// anywhere, inspected, or acted on — they're discarded outright. It exists
/// purely to avoid a POSIX socket gotcha: closing a socket that still has
/// unread inbound data queued can make the kernel send a RST instead of a
/// clean FIN, which can arrive at the peer before (and clobber) the
/// response we just wrote, turning our 502 into a bare connection reset.
/// Bounded by a short quiet period rather than waiting for EOF — the agent
/// is normally still holding its write half open, waiting to read our
/// response, so waiting for it to close first would deadlock.
async fn drain_pending(stream: &mut TcpStream) {
    let mut buf = [0u8; 4096];
    loop {
        match tokio::time::timeout(DRAIN_QUIET_PERIOD, stream.read(&mut buf)).await {
            Ok(Ok(0)) | Err(_) => return, // EOF, or nothing more within the window.
            Ok(Ok(_)) => continue,
            Ok(Err(_)) => return,
        }
    }
}

/// Drain whatever the agent already sent (see [`drain_pending`]), write the
/// fail-closed `502`, and half-close the write side — the one refusal path
/// every failure mode in [`splice`] funnels through, so there is exactly one
/// place that ever writes an error response.
async fn refuse(agent: &mut TcpStream) {
    drain_pending(agent).await;
    let _ = agent.write_all(BAD_GATEWAY).await;
    let _ = agent.shutdown().await;
}

/// Splice `agent` — a raw, already-accepted TCP connection from a local
/// agent — to the remote gateway at `gateway_addr` over mTLS, presenting
/// whatever client certificate `state` currently holds.
///
/// Thin wrapper over [`splice_with_dial_timeout`] fixing the dial/handshake
/// ceiling at [`RELAY_DIAL_TIMEOUT`] — split out so tests can exercise the
/// timeout path itself without waiting out the real production duration.
pub(crate) async fn splice(
    agent: TcpStream,
    state: Arc<ArcSwap<RelayCertState>>,
    gateway_addr: &str,
    server_name: &str,
) -> anyhow::Result<()> {
    splice_with_dial_timeout(agent, state, gateway_addr, server_name, RELAY_DIAL_TIMEOUT).await
}

/// On the success path, this never reads a single byte off `agent` itself:
/// it only ever touches `agent` through [`copy_bidirectional`], which moves
/// bytes in both directions without parsing them, so the agent's CONNECT
/// line and every header — including `Proxy-Authorization` — reach the
/// remote gateway exactly as written. Parsing, rewriting, or even peeking at
/// that data here would defeat the point of the relay.
///
/// Fails closed at every stage: an already-expired certificate, a dial
/// failure, a rejected/failed TLS handshake, or the dial+handshake exceeding
/// `dial_timeout` all end the same way — a `502 Bad Gateway` written to the
/// agent, then the connection is closed (see [`refuse`]). There is no other
/// fallback path. On those (only those) paths, whatever the agent already
/// sent is drained and discarded, unparsed, before responding — see
/// [`drain_pending`]'s doc for why.
async fn splice_with_dial_timeout(
    mut agent: TcpStream,
    state: Arc<ArcSwap<RelayCertState>>,
    gateway_addr: &str,
    server_name: &str,
    dial_timeout: Duration,
) -> anyhow::Result<()> {
    let current = state.load();

    if is_expired(current.not_after_unix, SystemTime::now()) {
        warn!("relay client certificate has expired -- refusing to dial the remote gateway");
        refuse(&mut agent).await;
        return Ok(());
    }

    let tls_config = Arc::clone(&current.tls_config);
    // Drop the loaded guard before the (potentially slow) dial below — an
    // `arc_swap::Guard` held across an await point would block a concurrent
    // renewal's `store` from ever completing.
    drop(current);

    let dial = tokio::time::timeout(dial_timeout, async {
        let tcp = TcpStream::connect(gateway_addr).await?;
        let name = ServerName::try_from(server_name.to_string())
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
        TlsConnector::from(tls_config).connect(name, tcp).await
    })
    .await;

    let mut gateway = match dial {
        Ok(Ok(tls)) => tls,
        Ok(Err(e)) => {
            warn!(
                error = %e,
                gateway = %gateway_addr,
                "relay could not establish an mTLS connection to the remote gateway -- refusing \
                 to fall back to a direct or plaintext connection"
            );
            refuse(&mut agent).await;
            return Ok(());
        }
        Err(_elapsed) => {
            warn!(
                gateway = %gateway_addr,
                timeout = ?dial_timeout,
                "relay dial/handshake to the remote gateway timed out -- refusing to fall back \
                 to a direct or plaintext connection"
            );
            refuse(&mut agent).await;
            return Ok(());
        }
    };

    match copy_bidirectional(&mut agent, &mut gateway).await {
        Ok((to_gateway, to_agent)) => {
            debug!(to_gateway, to_agent, "relay tunnel closed");
        }
        Err(e) => {
            debug!(error = %e, "relay tunnel ended");
        }
    }

    Ok(())
}

fn is_expired(not_after_unix: i64, now: SystemTime) -> bool {
    let not_after = UNIX_EPOCH + std::time::Duration::from_secs(not_after_unix.max(0) as u64);
    now > not_after
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    use rustls::pki_types::CertificateDer;
    use tokio::net::TcpListener;

    use crate::client_ca::test_support::{
        ensure_crypto_provider, new_test_ca, self_signed_server_cert, sign_client_leaf,
    };
    use crate::relay::enroll::build_client_tls_config;

    /// Encode raw DER bytes as a PEM certificate — test-only, mirroring the
    /// small per-module `der_to_pem` helpers already in this crate
    /// (`ca.rs`, `client_ca_authority.rs`) rather than sharing one.
    fn der_to_pem(der: &CertificateDer<'_>) -> String {
        let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, der.as_ref());
        let mut pem = String::from("-----BEGIN CERTIFICATE-----\n");
        for chunk in b64.as_bytes().chunks(64) {
            pem.push_str(std::str::from_utf8(chunk).expect("base64 is ascii"));
            pem.push('\n');
        }
        pem.push_str("-----END CERTIFICATE-----\n");
        pem
    }

    fn cert_state(
        tls_config: Arc<rustls::ClientConfig>,
        not_after_unix: i64,
    ) -> Arc<ArcSwap<RelayCertState>> {
        Arc::new(ArcSwap::from_pointee(RelayCertState {
            tls_config,
            not_after_unix,
        }))
    }

    /// SECURITY-critical: proves the relay never parses the agent's request.
    /// A fake gateway (a real TLS server, but with no client-cert
    /// requirement — irrelevant to what's under test here) records the raw
    /// bytes it receives and asserts the agent's CONNECT line and
    /// `Proxy-Authorization` header arrive byte-for-byte, then proves the
    /// tunnel is bidirectional by echoing a second write back through it.
    #[tokio::test]
    async fn splice_preserves_connect_line_and_proxy_auth_byte_for_byte() {
        ensure_crypto_provider();

        let (server_cert_pem, server_key_pem, server_der) = self_signed_server_cert();
        let server_ca_pem = der_to_pem(&server_der);

        let mut server_cert_reader = server_cert_pem.as_bytes();
        let server_chain: Vec<_> = rustls_pemfile::certs(&mut server_cert_reader)
            .collect::<Result<_, _>>()
            .expect("server chain");
        let mut server_key_reader = server_key_pem.as_bytes();
        let server_key = rustls_pemfile::private_key(&mut server_key_reader)
            .expect("parse server key")
            .expect("server key present");
        let server_config = Arc::new(
            rustls::ServerConfig::builder()
                .with_no_client_auth()
                .with_single_cert(server_chain, server_key)
                .expect("server config"),
        );

        // Any client cert works here — the fake gateway doesn't verify one.
        let issuer = new_test_ca("Any Issuer");
        let (client_cert_pem, client_key_pem) =
            sign_client_leaf(&issuer, Some("relay-1"), &[], -1, 24);
        let tls_config = build_client_tls_config(&client_cert_pem, &client_key_pem, &server_ca_pem)
            .expect("client config");

        let gateway_listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind gateway");
        let gateway_addr = gateway_listener.local_addr().expect("gateway addr");

        const CONNECT_LINE_AND_AUTH: &[u8] = b"CONNECT example.com:443 HTTP/1.1\r\n\
Host: example.com:443\r\n\
Proxy-Authorization: Basic YW9jX3Rlc3Q6\r\n\
\r\n";

        let gateway_task = tokio::spawn(async move {
            let (stream, _) = gateway_listener.accept().await.expect("gateway accept");
            let mut tls = tokio_rustls::TlsAcceptor::from(server_config)
                .accept(stream)
                .await
                .expect("gateway tls accept");

            let mut received = vec![0u8; CONNECT_LINE_AND_AUTH.len()];
            tls.read_exact(&mut received)
                .await
                .expect("read CONNECT + headers");

            tls.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await
                .expect("write 200");

            let mut ping = [0u8; 4];
            tls.read_exact(&mut ping).await.expect("read PING");
            tls.write_all(b"PONG").await.expect("write PONG");
            let _ = tls.shutdown().await;

            received
        });

        let relay_listener = TcpListener::bind("127.0.0.1:0").await.expect("bind relay");
        let relay_addr = relay_listener.local_addr().expect("relay addr");
        let state = cert_state(tls_config, i64::MAX);
        let gateway_addr_string = gateway_addr.to_string();
        let splice_task = tokio::spawn(async move {
            let (agent_stream, _) = relay_listener.accept().await.expect("relay accept");
            splice(agent_stream, state, &gateway_addr_string, "localhost").await
        });

        let mut agent = TcpStream::connect(relay_addr).await.expect("agent connect");
        agent
            .write_all(CONNECT_LINE_AND_AUTH)
            .await
            .expect("agent write CONNECT");

        let mut response = [0u8; "HTTP/1.1 200 Connection Established\r\n\r\n".len()];
        agent
            .read_exact(&mut response)
            .await
            .expect("agent read 200");
        assert_eq!(&response, b"HTTP/1.1 200 Connection Established\r\n\r\n");

        agent.write_all(b"PING").await.expect("agent write PING");
        let mut pong = [0u8; 4];
        agent.read_exact(&mut pong).await.expect("agent read PONG");
        assert_eq!(&pong, b"PONG");
        drop(agent);

        let received = gateway_task.await.expect("gateway task");
        assert_eq!(
            received.as_slice(),
            CONNECT_LINE_AND_AUTH,
            "the CONNECT line and Proxy-Authorization header must reach the gateway \
             byte-for-byte, unparsed"
        );

        splice_task.await.expect("splice task").expect("splice ok");
    }

    /// A gateway address that never refuses or completes a connection (a
    /// TEST-NET-1 black hole, per RFC 5737) must not hang the relay's
    /// per-connection task forever. Exercises `splice_with_dial_timeout`
    /// directly with a short override so the test doesn't have to wait out
    /// the real `RELAY_DIAL_TIMEOUT`; production `splice` wires the same
    /// path to the real constant.
    #[tokio::test]
    async fn splice_returns_502_when_the_dial_times_out() {
        ensure_crypto_provider();
        let ca = new_test_ca("Issuer");
        let (cert_pem, key_pem) = sign_client_leaf(&ca, Some("relay-1"), &[], -1, 24);
        let tls_config =
            build_client_tls_config(&cert_pem, &key_pem, &ca.cert.pem()).expect("config");
        // Not expired -- the timeout path, not the expiry short-circuit, is
        // what's under test here.
        let state = cert_state(tls_config, i64::MAX);

        let relay_listener = TcpListener::bind("127.0.0.1:0").await.expect("bind relay");
        let relay_addr = relay_listener.local_addr().expect("relay addr");
        let splice_task = tokio::spawn(async move {
            let (agent_stream, _) = relay_listener.accept().await.expect("relay accept");
            // Bounded well beyond the short override below, so a genuine
            // regression back to "no timeout at all" fails this test instead
            // of hanging the suite.
            tokio::time::timeout(
                Duration::from_secs(5),
                splice_with_dial_timeout(
                    agent_stream,
                    state,
                    "192.0.2.1:81",
                    "localhost",
                    Duration::from_millis(200),
                ),
            )
            .await
        });

        let mut agent = TcpStream::connect(relay_addr).await.expect("agent connect");
        agent
            .write_all(b"CONNECT example.com:443 HTTP/1.1\r\n\r\n")
            .await
            .expect("agent write");

        let mut response = Vec::new();
        agent
            .read_to_end(&mut response)
            .await
            .expect("agent read response");
        assert_eq!(
            response, BAD_GATEWAY,
            "a timed-out dial must produce a 502, never hang or fall back"
        );

        let outcome = splice_task
            .await
            .expect("splice task")
            .expect("must not hang past the 5s outer bound -- proves the dial timeout fired");
        outcome.expect("splice ok");
    }

    /// A certificate already past its `not_after` must never be dialed with
    /// — proven without any real gateway by using an address on the
    /// TEST-NET-1 documentation block (RFC 5737: guaranteed non-routable,
    /// so packets are dropped rather than refused). If `splice` attempted
    /// the dial anyway, this test would hang past the timeout below instead
    /// of returning almost immediately.
    #[tokio::test]
    async fn splice_refuses_to_dial_with_an_expired_certificate() {
        ensure_crypto_provider();
        let ca = new_test_ca("Issuer");
        let (cert_pem, key_pem) = sign_client_leaf(&ca, Some("relay-1"), &[], -1, 24);
        let tls_config =
            build_client_tls_config(&cert_pem, &key_pem, &ca.cert.pem()).expect("config");

        let already_expired = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
            - 3600;
        let state = cert_state(tls_config, already_expired);

        let relay_listener = TcpListener::bind("127.0.0.1:0").await.expect("bind relay");
        let relay_addr = relay_listener.local_addr().expect("relay addr");
        let splice_task = tokio::spawn(async move {
            let (agent_stream, _) = relay_listener.accept().await.expect("relay accept");
            tokio::time::timeout(
                Duration::from_millis(500),
                splice(agent_stream, state, "192.0.2.1:81", "localhost"),
            )
            .await
        });

        let mut agent = TcpStream::connect(relay_addr).await.expect("agent connect");
        agent
            .write_all(b"CONNECT example.com:443 HTTP/1.1\r\n\r\n")
            .await
            .expect("agent write");

        let mut response = Vec::new();
        agent
            .read_to_end(&mut response)
            .await
            .expect("agent read response");
        assert_eq!(response, BAD_GATEWAY);

        let outcome = splice_task
            .await
            .expect("splice task")
            .expect("must not hang past the timeout -- proves no dial was attempted");
        outcome.expect("splice ok");
    }

    /// The remote gateway's server certificate is signed by a DIFFERENT CA
    /// than `--gateway-server-ca` trusts. The TLS handshake must fail, the
    /// agent must get a `502`, and — since the relay never gets past the
    /// handshake — no plaintext (or any other) data can possibly reach the
    /// gateway.
    #[tokio::test]
    async fn splice_returns_502_when_the_server_certificate_is_untrusted() {
        ensure_crypto_provider();

        // The relay trusts THIS CA as the server trust anchor...
        let trusted_server_ca = new_test_ca("Trusted Server CA");
        // ...but the fake gateway presents an UNRELATED self-signed server
        // certificate the relay never configured as a root. No client-cert
        // requirement here (`with_no_client_auth`) so the ONLY reason the
        // handshake can fail is the server-certificate mismatch this test
        // is about — not an unrelated client-auth rejection.
        let (server_cert_pem, server_key_pem, _server_der) = self_signed_server_cert();
        let mut server_cert_reader = server_cert_pem.as_bytes();
        let server_chain: Vec<_> = rustls_pemfile::certs(&mut server_cert_reader)
            .collect::<Result<_, _>>()
            .expect("server chain");
        let mut server_key_reader = server_key_pem.as_bytes();
        let server_key = rustls_pemfile::private_key(&mut server_key_reader)
            .expect("parse server key")
            .expect("server key present");
        let server_config = Arc::new(
            rustls::ServerConfig::builder()
                .with_no_client_auth()
                .with_single_cert(server_chain, server_key)
                .expect("server config"),
        );

        let issuer = new_test_ca("Any Issuer");
        let (client_cert_pem, client_key_pem) =
            sign_client_leaf(&issuer, Some("relay-1"), &[], -1, 24);
        let tls_config = build_client_tls_config(
            &client_cert_pem,
            &client_key_pem,
            &trusted_server_ca.cert.pem(),
        )
        .expect("client config");
        let state = cert_state(tls_config, i64::MAX);

        let gateway_listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind gateway");
        let gateway_addr = gateway_listener.local_addr().expect("gateway addr");
        let gateway_task = tokio::spawn(async move {
            let (stream, _) = gateway_listener.accept().await.expect("gateway accept");
            tokio_rustls::TlsAcceptor::from(server_config)
                .accept(stream)
                .await
        });

        let relay_listener = TcpListener::bind("127.0.0.1:0").await.expect("bind relay");
        let relay_addr = relay_listener.local_addr().expect("relay addr");
        let gateway_addr_string = gateway_addr.to_string();
        let splice_task = tokio::spawn(async move {
            let (agent_stream, _) = relay_listener.accept().await.expect("relay accept");
            splice(agent_stream, state, &gateway_addr_string, "localhost").await
        });

        let mut agent = TcpStream::connect(relay_addr).await.expect("agent connect");
        agent
            .write_all(b"CONNECT example.com:443 HTTP/1.1\r\n\r\n")
            .await
            .expect("agent write");

        let mut response = Vec::new();
        agent
            .read_to_end(&mut response)
            .await
            .expect("agent read response");
        assert_eq!(
            response, BAD_GATEWAY,
            "an untrusted server certificate must produce a 502, never a plaintext fallback"
        );

        // The gateway's own TLS accept must also have failed (or the
        // connection was dropped before completing) — confirming the
        // rejection happened during the handshake, not after.
        let gateway_result = gateway_task.await.expect("gateway task join");
        assert!(
            gateway_result.is_err(),
            "gateway handshake should not complete"
        );

        splice_task.await.expect("splice task").expect("splice ok");
    }
}
