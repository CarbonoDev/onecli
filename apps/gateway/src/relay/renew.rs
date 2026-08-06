//! Certificate renewal for the relay: a pure scheduling function
//! ([`next_renewal`]) plus the loop that drives it.

use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use arc_swap::ArcSwap;
use tracing::{error, info, warn};

use super::enroll::{build_client_tls_config, enroll};
use super::{unix_now, RelayCertState, RenewalArgs};

/// Never renew with less than this much lead time, no matter how short the
/// certificate's lifetime is — a certificate issued with a one-minute
/// lifetime still gets *some* runway before the relay tries to replace it.
const MIN_RENEWAL_LEAD: Duration = Duration::from_secs(5 * 60);

/// Initial backoff between renewal retries after a failure; doubles on each
/// subsequent failure up to [`MAX_RETRY_BACKOFF`].
const INITIAL_RETRY_BACKOFF: Duration = Duration::from_secs(5);

/// Ceiling on the retry backoff.
const MAX_RETRY_BACKOFF: Duration = Duration::from_secs(300);

/// When to renew a certificate whose expiry is `not_after_unix` (unix
/// seconds) and whose total issued `lifetime` is known, relative to `now`.
///
/// Re-mints at `not_after - max(lifetime / 3, 5 minutes)`: a comfortable
/// third of the lifetime is spent as lead time, floored at five minutes so a
/// very short-lived certificate still gets renewed well before it expires
/// rather than at the last possible instant. A `not_after` that (relative to
/// `now`, once the lead is subtracted) has already passed renews
/// immediately — this function never returns a point in `now`'s past.
///
/// Pure — no clock access beyond the two parameters — so it's directly
/// unit-testable; the only production clock reads are the `now`/`Instant`
/// values callers pass in and compute against.
pub(crate) fn next_renewal(not_after_unix: i64, now: SystemTime, lifetime: Duration) -> Instant {
    let lead = std::cmp::max(lifetime / 3, MIN_RENEWAL_LEAD);
    let not_after = UNIX_EPOCH + Duration::from_secs(not_after_unix.max(0) as u64);
    let renew_at = not_after.checked_sub(lead).unwrap_or(UNIX_EPOCH);

    let delay = renew_at.duration_since(now).unwrap_or(Duration::ZERO);
    Instant::now() + delay
}

/// Drive certificate renewal for the life of the relay.
///
/// Each cycle: sleep until [`next_renewal`], then re-enroll reusing
/// `args.host_id` (so the API's `ensureClientHost` re-mints against the SAME
/// row/identity instead of accumulating a new one per renewal), rebuild the
/// TLS config, and swap it into `state`. In-flight tunnels hold their own
/// `Arc<RelayCertState>` snapshot taken before the swap and are unaffected;
/// only NEW dials pick up the fresh config.
///
/// Fail-closed on persistent failure: once the CURRENT certificate is past
/// `not_after_unix` and a renewal attempt still fails, this stops retrying
/// entirely rather than keep looping forever behind an already-expired
/// certificate (new connections then fail closed too — see
/// `tunnel::splice`'s own expiry check, which the state this loop stopped
/// updating no longer changes).
pub(crate) async fn renewal_loop(
    args: RenewalArgs,
    mut lifetime: Duration,
    mut not_after_unix: i64,
    state: Arc<ArcSwap<RelayCertState>>,
) {
    let mut shutdown_signal = crate::shutdown::subscribe();

    loop {
        let deadline = next_renewal(not_after_unix, SystemTime::now(), lifetime);
        tokio::select! {
            _ = tokio::time::sleep_until(deadline.into()) => {},
            _ = shutdown_signal.wait() => return,
        }

        let mut backoff = INITIAL_RETRY_BACKOFF;
        loop {
            match enroll(
                &args.api_url,
                &args.api_key,
                &args.csr_pem,
                Some(args.host_id.clone()),
                args.label.clone(),
            )
            .await
            {
                Ok(resp) => {
                    match build_client_tls_config(
                        &resp.cert_pem,
                        &args.key_pem,
                        &args.server_ca_pem,
                    ) {
                        Ok(tls_config) => {
                            not_after_unix = resp.not_after_unix;
                            lifetime = Duration::from_secs(
                                not_after_unix.saturating_sub(unix_now()).max(0) as u64,
                            );
                            state.store(Arc::new(RelayCertState {
                                tls_config,
                                not_after_unix,
                            }));
                            if let Some(dir) = &args.state_dir {
                                if let Err(e) = super::persist_state(
                                    dir,
                                    &args.key_pem,
                                    &resp.cert_pem,
                                    &args.host_id,
                                )
                                .await
                                {
                                    warn!(error = ?e, "failed to persist renewed relay state");
                                }
                            }
                            info!(
                                host_id = %args.host_id,
                                not_after = not_after_unix,
                                "relay certificate renewed"
                            );
                            // Only the success path exits the retry loop —
                            // see the `Err` arm just below for why a rebuild
                            // failure must NOT also `break` here.
                            break;
                        }
                        Err(e) => {
                            // A rebuild failure must fall through to the
                            // SAME backoff-then-retry tail as an `enroll`
                            // failure (below), not `break` unconditionally:
                            // breaking here would return to the outer loop
                            // with `not_after_unix` unchanged (still at or
                            // past expiry, since that's normally why a
                            // renewal fired in the first place), which
                            // recomputes `next_renewal` as "renew
                            // immediately" and re-enrolls again right away —
                            // a tight, network-hammering hot loop whenever
                            // `enroll` keeps succeeding but the resulting
                            // certificate keeps failing to build into a TLS
                            // config. Falling through instead applies the
                            // same exponential backoff, and the old (still
                            // valid, unexpired) config already in `state`
                            // keeps serving new connections in the meantime.
                            if unix_now() >= not_after_unix {
                                error!(
                                    error = ?e,
                                    "renewed certificate failed to build a TLS config and the \
                                     current certificate has already expired -- stopping renewal \
                                     rather than keep retrying behind an expired certificate"
                                );
                                return;
                            }
                            warn!(
                                error = ?e,
                                backoff = ?backoff,
                                "renewed certificate failed to build a TLS config, retrying"
                            );
                        }
                    }
                }
                Err(e) => {
                    if unix_now() >= not_after_unix {
                        error!(
                            error = ?e,
                            "certificate renewal is failing and the current certificate has \
                             already expired -- stopping renewal rather than keep retrying \
                             behind an expired certificate"
                        );
                        return;
                    }
                    warn!(error = ?e, backoff = ?backoff, "certificate renewal failed, retrying");
                }
            }

            tokio::select! {
                _ = tokio::time::sleep(backoff) => {},
                _ = shutdown_signal.wait() => return,
            }
            backoff = (backoff * 2).min(MAX_RETRY_BACKOFF);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(actual: Duration, expected: Duration, slack: Duration) -> bool {
        actual.abs_diff(expected) <= slack
    }

    #[test]
    fn next_renewal_24h_lifetime_renews_with_a_third_left() {
        let now = SystemTime::now();
        let lifetime = Duration::from_secs(24 * 3600);
        let not_after = (now + lifetime)
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        let scheduled = next_renewal(not_after, now, lifetime);
        let delay = scheduled.saturating_duration_since(Instant::now());

        // lead = max(8h, 5min) = 8h -> renew 16h from now.
        assert!(
            approx(
                delay,
                Duration::from_secs(16 * 3600),
                Duration::from_secs(5)
            ),
            "expected ~16h, got {delay:?}"
        );
    }

    #[test]
    fn next_renewal_max_lifetime_uses_a_third_as_lead() {
        let now = SystemTime::now();
        let lifetime = Duration::from_secs(7 * 24 * 3600); // MAX_LIFETIME
        let not_after = (now + lifetime)
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        let scheduled = next_renewal(not_after, now, lifetime);
        let delay = scheduled.saturating_duration_since(Instant::now());

        // lead = lifetime / 3 = 56h -> renew 112h from now.
        assert!(
            approx(
                delay,
                Duration::from_secs(112 * 3600),
                Duration::from_secs(5)
            ),
            "expected ~112h, got {delay:?}"
        );
    }

    #[test]
    fn next_renewal_short_lifetime_floors_at_five_minutes() {
        let now = SystemTime::now();
        let lifetime = Duration::from_secs(600); // 10 minutes: lifetime/3 ~= 3.3min
        let not_after = (now + lifetime)
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        let scheduled = next_renewal(not_after, now, lifetime);
        let delay = scheduled.saturating_duration_since(Instant::now());

        assert!(
            approx(delay, MIN_RENEWAL_LEAD, Duration::from_secs(5)),
            "expected the 5-minute floor, got {delay:?}"
        );
    }

    #[test]
    fn next_renewal_past_not_after_renews_immediately() {
        let now = SystemTime::now();
        let not_after = now
            .checked_sub(Duration::from_secs(3600))
            .unwrap()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        let scheduled = next_renewal(not_after, now, Duration::from_secs(24 * 3600));
        let delay = scheduled.saturating_duration_since(Instant::now());

        assert!(
            delay < Duration::from_millis(50),
            "expected ~immediate renewal, got {delay:?}"
        );
    }

    #[test]
    fn next_renewal_never_schedules_in_the_past_relative_to_now() {
        // Even a wildly-in-the-past not_after must not underflow/panic —
        // it just collapses to "renew immediately".
        let now = SystemTime::now();
        let scheduled = next_renewal(0, now, Duration::from_secs(3600));
        assert!(scheduled <= Instant::now() + Duration::from_millis(50));
    }

    // ── renewal_loop: rebuild-failure backs off instead of hot-looping ───

    /// Regression guard: a `build_client_tls_config` failure on a
    /// successfully-`enroll`ed certificate used to `break` straight back to
    /// the outer loop with `not_after_unix` unchanged (already in the past,
    /// since that's normally why a renewal fired) — `next_renewal` then
    /// recomputes "renew immediately" and the loop re-hits the enrollment
    /// endpoint at full speed. This drives the real `renewal_loop` against a
    /// fake enrollment endpoint that always returns a `certPem` garbage
    /// enough to fail `build_client_tls_config`, for a bounded window, and
    /// asserts the endpoint was hit at most once — proving the backoff (far
    /// longer than the window) is what's gating the retries, not a hot loop.
    #[tokio::test]
    async fn renewal_loop_backs_off_after_a_tls_rebuild_failure_instead_of_hot_looping() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        use crate::client_ca::test_support::{
            ensure_crypto_provider, new_test_ca, sign_client_leaf,
        };
        use crate::relay::enroll::build_client_tls_config;

        ensure_crypto_provider();

        let hits = Arc::new(AtomicUsize::new(0));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        listener.set_nonblocking(true).expect("nonblocking");

        let hits_server = Arc::clone(&hits);
        let window = Duration::from_millis(300);
        let server = std::thread::spawn(move || {
            use std::io::{Read, Write};
            let deadline = std::time::Instant::now() + window + Duration::from_millis(200);
            while std::time::Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).ok();
                        let mut buf = [0u8; 4096];
                        let _ = stream.read(&mut buf);
                        hits_server.fetch_add(1, Ordering::SeqCst);
                        // `certPem` is not a certificate at all --
                        // `enroll` succeeds at the HTTP level, but the
                        // caller's `build_client_tls_config` must fail.
                        let body = concat!(
                            "{\"identity\":\"spiffe://onecli/host/x\",",
                            "\"hostId\":\"x\",",
                            "\"certPem\":\"not a certificate\",",
                            "\"caPem\":\"CA\",",
                            "\"serial\":\"aa\",",
                            "\"notAfter\":1}"
                        );
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n{}",
                            body.len(),
                            body
                        );
                        let _ = stream.write_all(resp.as_bytes());
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    Err(_) => break,
                }
            }
        });

        // A syntactically valid (but otherwise irrelevant) starting config —
        // never dialed in this test, just needs to exist as the ArcSwap's
        // initial value.
        let ca = new_test_ca("Dummy");
        let (cert_pem, key_pem) = sign_client_leaf(&ca, Some("relay-1"), &[], -1, 24);
        let initial_config =
            build_client_tls_config(&cert_pem, &key_pem, &ca.cert.pem()).expect("initial config");

        // NOT yet expired -- a couple of seconds of runway, comfortably
        // longer than `window`. This is what distinguishes the scenario
        // under test (a rebuild failure while there's still time left, which
        // must back off and keep the loop alive) from the separate
        // stop-on-expiry path (already covered by `renewal_loop`'s doc and
        // exercised structurally by `next_renewal`'s own past-due tests):
        // if `not_after_unix` were already in the past, the very first
        // failure would legitimately return/stop rather than back off, which
        // would make this test pass for the wrong reason.
        let not_yet_expired = unix_now() + 2;
        let state = Arc::new(ArcSwap::from_pointee(RelayCertState {
            tls_config: initial_config,
            not_after_unix: not_yet_expired,
        }));

        let renewal_args = RenewalArgs {
            api_url: format!("http://{addr}"),
            api_key: "oc_test".to_string(),
            label: None,
            host_id: "host-x".to_string(),
            csr_pem: "csr".to_string(),
            key_pem,
            server_ca_pem: ca.cert.pem(),
            state_dir: None,
        };

        let loop_task = tokio::spawn(renewal_loop(
            renewal_args,
            Duration::from_secs(3600),
            not_yet_expired,
            state,
        ));

        tokio::time::sleep(window).await;
        loop_task.abort();
        let _ = loop_task.await;
        let _ = server.join();

        assert!(
            hits.load(Ordering::SeqCst) <= 1,
            "expected the backoff to gate retries within {window:?} (at most one hit), got {} \
             -- a rebuild failure must not hot-loop",
            hits.load(Ordering::SeqCst)
        );
    }
}
