#[cfg(edition_oss)]
mod auth;

#[cfg(any(edition_onprem_slim, edition_onprem_full))]
#[path = "ee/onprem/auth.rs"]
mod auth;

#[cfg(edition_cloud)]
#[path = "ee/auth.rs"]
mod auth;

mod ca;
mod client_ca;
mod client_ca_authority;

#[cfg(not(edition_cloud))]
mod cache;

#[cfg(edition_cloud)]
#[path = "ee/cache.rs"]
mod cache;

#[cfg(not(edition_cloud))]
mod approval;

#[cfg(edition_cloud)]
#[path = "ee/approval.rs"]
mod approval;

mod apps;

#[cfg(edition_oss)]
mod ee_apps;

#[cfg(not(edition_oss))]
#[path = "ee/ee_apps.rs"]
mod ee_apps;

#[cfg(edition_oss)]
mod org_routes;

#[cfg(not(edition_oss))]
#[path = "ee/org_routes.rs"]
mod org_routes;

mod connect;

// Body-condition matcher (Tier 3a): the OSS arm evaluates body/header
// conditions byte-level over the buffered request body and headers, at both
// org and project scopes, with the fail-closed-by-action failure law (an
// unevaluable condition over-blocks a Block rule and drops any other). The EE
// build swaps in the cloud overlay via the `#[path]` module below.
#[cfg(edition_oss)]
mod condition_match;

#[cfg(not(edition_oss))]
#[path = "ee/condition_match.rs"]
mod condition_match;

#[cfg(not(edition_cloud))]
mod crypto;

#[cfg(edition_cloud)]
#[path = "ee/crypto.rs"]
mod crypto;

mod db;
mod default_interceptions;
mod edition;
mod gateway;
mod inject;
mod policy;
mod relay;
mod secret_inject;
mod shutdown;
mod summary;

// Cloud-only request summarizers for manual-approval cards. OSS build uses the
// no-op `cloud_summary.rs` stub; the cloud build swaps in `ee/cloud_summary.rs`
// (+ the `ee/cloud_summary/` submodules). Mirrors the `ee_apps` split, and
// is the fall-through arm of `summary`'s per-provider dispatch.
#[cfg(not(edition_cloud))]
mod cloud_summary;

#[cfg(edition_cloud)]
#[path = "ee/cloud_summary.rs"]
mod cloud_summary;

mod telemetry_core;
mod util;
mod version;

#[cfg(not(edition_cloud))]
mod telemetry;

#[cfg(edition_cloud)]
#[path = "ee/telemetry.rs"]
mod telemetry;

// Partner layer (cloud-only). OSS build uses the no-op `partner.rs` stub; the
// cloud build swaps in `ee/partner.rs` (+ the `ee/partner/` submodules).
#[cfg(not(edition_cloud))]
mod partner;

#[cfg(edition_cloud)]
#[path = "ee/partner.rs"]
mod partner;

// Granular access (EE — cloud + onprem): generic per-agent scoping for app
// connections — token-level (e.g. GitHub repo-scoped tokens) or request-level
// (e.g. Dropbox folder allowlist). No OSS stub: referenced only from the cloud/
// onprem hooks + ee_apps modules, which are all cfg'd out for oss.
#[cfg(not(edition_oss))]
#[path = "ee/granular_access.rs"]
mod granular_access;

// Budget layer (cloud-only). OSS build uses the no-op `budget.rs` stub; the
// cloud build swaps in `ee/budget.rs` (+ the `ee/budget/` submodules).
#[cfg(not(edition_cloud))]
mod budget;

#[cfg(edition_cloud)]
#[path = "ee/budget.rs"]
mod budget;

// Policy engine (step 9.5): OSS compiles the minimal project-only first-match
// core (src/policy_engine.rs + src/policy_engine/); every EE edition — cloud AND
// both onprems — swaps in the full engine (ee/policy_engine.rs, org scope +
// principals + availability).
#[cfg(edition_oss)]
mod policy_engine;

#[cfg(not(edition_oss))]
#[path = "ee/policy_engine.rs"]
mod policy_engine;

mod vault;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::Parser;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

use crate::ca::CertificateAuthority;
use crate::connect::PolicyEngine;
use crate::gateway::GatewayServer;
use crate::vault::bitwarden::{BitwardenConfig, BitwardenVaultProvider};
use crate::vault::onepassword::OnePasswordVaultProvider;
use crate::vault::{VaultProvider, VaultService};

#[derive(Parser)]
#[command(
    name = "onecli-gateway",
    about = "OneCLI MITM gateway for credential injection"
)]
struct Cli {
    /// Port to listen on.
    #[arg(long, default_value = "10255")]
    port: u16,

    /// Data directory for CA certificates and persistent state.
    #[arg(long, default_value = default_data_dir())]
    data_dir: PathBuf,

    /// Optional subcommand. With none given, `onecli-gateway` (optionally
    /// with `--port`/`--data-dir`) parses exactly as it always has and runs
    /// the MITM gateway server — see the module doc on `Command` below for
    /// why that byte-for-byte compatibility matters.
    #[command(subcommand)]
    command: Option<Command>,
}

/// Subcommands layered onto the historically flag-only `onecli-gateway` CLI.
///
/// `command` on [`Cli`] is `Option<Command>`, not `Command`, specifically so
/// that omitting it entirely — the only way this binary has ever been
/// invoked before this change — continues to select the server, not a clap
/// error demanding a subcommand. `main` dispatches on it before any of the
/// server's own CA/DB/crypto/vault bootstrapping runs, so `relay` never pays
/// for (or requires) any of that.
#[derive(clap::Subcommand, Debug)]
enum Command {
    /// Run a local mTLS relay: a blind byte-splice between a plain
    /// HTTP-proxy agent and a remote OneCLI gateway. See `relay.rs`'s module
    /// doc for the security property this preserves.
    Relay(relay::RelayArgs),
}

/// Cap on the final telemetry flush, inside the overall shutdown budget.
const TELEMETRY_FLUSH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// Cap on closing the database pool — cosmetic cleanliness, never worth a hang.
const POOL_CLOSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

fn default_data_dir() -> &'static str {
    if cfg!(target_os = "linux") && Path::new("/app/data").exists() {
        "/app/data"
    } else {
        "~/.onecli"
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // Install ring as the default rustls CryptoProvider (required by reqwest)
    if rustls::crypto::ring::default_provider()
        .install_default()
        .is_err()
    {
        eprintln!("fatal: failed to install rustls CryptoProvider");
        std::process::exit(1);
    }

    // Initialize logging — JSON for production (CloudWatch), text for dev
    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    if std::env::var("LOG_FORMAT").as_deref() == Ok("json") {
        tracing_subscriber::fmt()
            .json()
            .with_env_filter(env_filter)
            .with_target(true)
            .flatten_event(true)
            .init();
    } else {
        tracing_subscriber::fmt().with_env_filter(env_filter).init();
    }

    let cli = Cli::parse();

    // Before anything that can block: as PID 1 the kernel discards a SIGTERM
    // whose handler is still the default, so until this runs the process
    // cannot be stopped by anything short of SIGKILL. A signal arriving during
    // the startup below simply sets the flag, and the accept loop exits on its
    // first poll.
    shutdown::install();

    // Relay mode is an entirely separate program sharing only the process's
    // signal handling and rustls crypto provider install above: no CA, no
    // database, no crypto service, no vault. Dispatched here, before any of
    // that server-only bootstrapping below runs, so it never pays for (or
    // requires) any of it.
    if let Some(Command::Relay(args)) = cli.command {
        return relay::run(args).await;
    }

    // Expand ~ in data dir
    let data_dir = expand_tilde(&cli.data_dir);

    let caps = edition::capabilities();
    info!(
        data_dir = %data_dir.display(),
        edition = ?caps.edition,
        demo = caps.demo,
        "starting onecli-gateway"
    );

    // The gateway puts absolute links into the responses agents relay to humans
    // ("open this URL to connect the app"). It answers proxy traffic, so unlike
    // the web app it has no incoming browser request to derive its own address
    // from — APP_URL is the only thing that can tell it. Say so once, loudly,
    // rather than emitting links that look real and go nowhere.
    if !gateway::response::app_url_is_configured() {
        warn!(
            fallback = gateway::response::DASHBOARD_URL_FALLBACK,
            "APP_URL is not set — links in agent-facing responses will point at \
             the fallback and will not open for anyone reaching OneCLI on a \
             different address. Set APP_URL to the URL users browse to."
        );
    }

    // Load or generate CA
    let ca = CertificateAuthority::load_or_generate(&data_dir).await?;
    info!("CA certificate loaded");

    // Client-certificate minting authority (Phase 2). Only meaningful when
    // the mTLS trust anchor is the gateway's OWN generated client CA: if an
    // operator has configured GATEWAY_CLIENT_CA (Phase 1 — an externally
    // managed trust anchor cert, whose matching private key we never hold),
    // minting against a locally generated CA would produce certificates
    // nobody trusts. In that case, skip generating/loading a client CA
    // entirely and leave minting unavailable (the internal endpoint 503s)
    // rather than silently minting from an unrelated CA. Any OTHER failure
    // here (a corrupt on-disk key, an unwritable data dir, ...) aborts
    // startup — fail closed, mirroring `ca::CertificateAuthority`.
    let operator_configured_client_ca = std::env::var("GATEWAY_CLIENT_CA")
        .ok()
        .is_some_and(|v| !v.trim().is_empty());
    let client_ca: Option<Arc<client_ca_authority::ClientCa>> = if operator_configured_client_ca {
        info!(
            "GATEWAY_CLIENT_CA is set — client-certificate minting stays unavailable (the \
             internal endpoint 503s); the trust anchor is externally managed"
        );
        None
    } else {
        let authority = client_ca_authority::ClientCa::load_or_generate(&data_dir).await?;
        info!("client-certificate CA loaded");
        Some(Arc::new(authority))
    };
    let fallback_client_ca_pem = client_ca.as_ref().map(|c| c.ca_cert_pem());

    // mTLS is opt-in: unset GATEWAY_MTLS_PORT and this is a no-op (full
    // backward compatibility). When it IS requested, any load failure here
    // must abort startup — the gateway must never silently fall back to
    // plaintext-only when mTLS was asked for.
    let mtls = client_ca::MtlsConfig::from_env(
        ca.ca_cert_der(),
        cli.port,
        fallback_client_ca_pem.as_deref(),
    )?;
    match &mtls {
        Some(m) => info!(port = m.port, "mTLS client-certificate listener configured"),
        None => info!("mTLS disabled (GATEWAY_MTLS_PORT not set)"),
    }

    // Connect to PostgreSQL
    // Support both DATABASE_URL (OSS) and individual DB_* vars (cloud ECS from Secrets Manager)
    let database_url = match std::env::var("DATABASE_URL") {
        Ok(url) => url,
        Err(_) => {
            let host =
                std::env::var("DB_HOST").context("DATABASE_URL or DB_HOST env var must be set")?;
            let port = std::env::var("DB_PORT").unwrap_or_else(|_| "5432".to_string());
            let user = std::env::var("DB_USERNAME").context("DB_USERNAME env var must be set")?;
            let pass = std::env::var("DB_PASSWORD").context("DB_PASSWORD env var must be set")?;
            let name = std::env::var("DB_NAME").unwrap_or_else(|_| "onecli".to_string());
            format!("postgresql://{user}:{pass}@{host}:{port}/{name}")
        }
    };
    let pool = db::create_pool(&database_url).await?;
    info!("database pool created");
    let telemetry_pool = pool.clone();
    // The pool itself moves into the PolicyEngine below, and that moves into
    // the server — so the shutdown sequence needs its own handle to close it.
    let shutdown_pool = pool.clone();

    // Load crypto service for secret decryption
    // OSS: AES-256-GCM with local key from SECRET_ENCRYPTION_KEY
    // Cloud: KMS envelope decryption (calls KMS Decrypt for each data key)
    let crypto = Arc::new(crypto::CryptoService::from_env().await?);
    info!("crypto service initialized");

    // Build the 1Password provider once and share the Arc: the PolicyEngine
    // resolves `op://` secret values through it, and the VaultService registers
    // it as a provider (connection holder for pair/status/picker).
    let onepassword = Arc::new(OnePasswordVaultProvider::new(
        pool.clone(),
        Arc::clone(&crypto),
    ));

    let policy_engine = Arc::new(PolicyEngine {
        pool,
        crypto: Arc::clone(&crypto),
        onepassword: Arc::clone(&onepassword),
    });

    // Initialize vault service with Bitwarden + 1Password providers.
    let proxy_url = std::env::var("BITWARDEN_PROXY_URL")
        .unwrap_or_else(|_| "wss://ap.lesspassword.dev".to_string());
    let bitwarden = BitwardenVaultProvider::new(
        BitwardenConfig { proxy_url },
        policy_engine.pool.clone(),
        Arc::clone(&crypto),
    );
    let providers: Vec<Arc<dyn VaultProvider>> = vec![Arc::new(bitwarden), onepassword];
    let vault_service = Arc::new(VaultService::new(providers, policy_engine.pool.clone()));
    info!("vault service initialized");

    // Initialize cache store
    // OSS: in-memory DashMap. Cloud: Redis (ElastiCache with TLS + AUTH).
    let cache = cache::create_store().await?;
    info!("cache store created");

    // Initialize approval store for manual approval policy action
    // OSS: in-memory DashMap + tokio channels. Cloud: Redis + BLPOP.
    let approval_store = approval::create_store().await?;
    info!("approval store created");

    telemetry::init(telemetry_pool, Arc::clone(&cache));
    info!("telemetry initialized");

    // No port here: it would report the *requested* value, which is `0` when the
    // OS is asked to choose. The listening line logs the address actually bound.
    info!("gateway ready");

    // Serve until a shutdown signal stops the listener.
    let server = GatewayServer::new(
        ca,
        cli.port,
        policy_engine,
        vault_service,
        cache,
        approval_store,
        mtls,
        client_ca,
    )?;
    let result = server.run().await;

    // The drain, in the one order that does not lose data: connections first
    // (they are still emitting telemetry as they finish), then the telemetry
    // flush that persists what they emitted, then the database it wrote to.
    // Every phase draws from one budget, so the total cannot outrun the
    // orchestrator's patience however it is configured.
    let budget = shutdown::Budget::start();
    let drained = shutdown::drain_connections(budget.drain_share()).await;
    if !drained {
        warn!("drain deadline reached — remaining connections will be cut");
    }
    telemetry_core::shutdown(budget.allow(TELEMETRY_FLUSH_TIMEOUT)).await;
    // Bounded: a detached approval-cleanup task can briefly hold a connection,
    // and no amount of tidiness is worth missing the SIGKILL deadline.
    let _ = tokio::time::timeout(budget.allow(POOL_CLOSE_TIMEOUT), shutdown_pool.close()).await;

    info!(drained, "drain complete");
    result
}

/// Expand `~` at the start of a path to the user's home directory.
fn expand_tilde(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if s.starts_with("~/") || s == "~" {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(s.strip_prefix("~/").unwrap_or(""));
        }
    }
    path.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The default invocation — no subcommand at all — must keep parsing to
    /// the server arm exactly as it did before `Command` existed. This is
    /// the regression guard for every existing deployment's `onecli-gateway`
    /// (with no args) or `onecli-gateway --port N` invocation.
    #[test]
    fn no_subcommand_parses_to_the_server_arm() {
        let cli = Cli::try_parse_from(["onecli-gateway"]).expect("parses with no args");
        assert_eq!(cli.port, 10255);
        assert!(cli.command.is_none());
    }

    #[test]
    fn port_flag_alone_still_parses_to_the_server_arm() {
        let cli = Cli::try_parse_from(["onecli-gateway", "--port", "9999"]).expect("parses --port");
        assert_eq!(cli.port, 9999);
        assert!(cli.command.is_none());
    }

    #[test]
    fn data_dir_flag_alone_still_parses_to_the_server_arm() {
        let cli = Cli::try_parse_from(["onecli-gateway", "--data-dir", "/tmp/onecli-data"])
            .expect("parses --data-dir");
        assert_eq!(cli.data_dir, PathBuf::from("/tmp/onecli-data"));
        assert!(cli.command.is_none());
    }

    /// The new `relay` subcommand parses into `Command::Relay` with its
    /// required fields populated — proving the subcommand addition didn't
    /// break argument routing in either direction.
    #[test]
    fn relay_subcommand_parses_its_required_args() {
        let cli = Cli::try_parse_from([
            "onecli-gateway",
            "relay",
            "--gateway-addr",
            "gateway.example.com:8443",
            "--gateway-server-ca",
            "/etc/onecli/server-ca.pem",
            "--api-url",
            "https://api.example.com",
            "--api-key",
            "oc_test_key",
        ])
        .expect("parses relay subcommand");

        match cli.command {
            Some(Command::Relay(args)) => {
                assert_eq!(args.gateway_addr, "gateway.example.com:8443");
                assert_eq!(args.api_url, "https://api.example.com");
                assert_eq!(args.api_key, "oc_test_key");
                assert_eq!(
                    args.bind,
                    "127.0.0.1:10255".parse::<std::net::SocketAddr>().unwrap()
                );
            }
            None => panic!("expected Command::Relay"),
        }
    }

    /// Missing a required relay flag (with its env var also unset) must
    /// fail to parse rather than silently default — `--gateway-addr` has no
    /// default and nothing here sets `RELAY_GATEWAY_ADDR`.
    #[test]
    fn relay_subcommand_requires_gateway_addr() {
        // Isolated from whatever the test process's real environment holds:
        // if `RELAY_GATEWAY_ADDR` happened to be set, this would spuriously
        // pass. There is no portable safe env-mutation in a parallel test
        // binary, so this only asserts what it can control directly: the
        // flag form is absent, and if the env var were also absent this
        // must fail.
        if std::env::var("RELAY_GATEWAY_ADDR").is_ok() {
            return;
        }
        let result = Cli::try_parse_from([
            "onecli-gateway",
            "relay",
            "--gateway-server-ca",
            "/etc/onecli/server-ca.pem",
            "--api-url",
            "https://api.example.com",
            "--api-key",
            "oc_test_key",
        ]);
        assert!(result.is_err(), "must require --gateway-addr");
    }
}
