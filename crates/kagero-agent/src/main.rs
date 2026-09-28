//! kagero — PID 1 supervisor for AWS Lambda MicroVMs.
//!
//! Usage: `kagero -- <app command...>`
//! Order of business (microvms.md §4): bind the hook and admin ports,
//! start the collector (build mode only), spawn the app with dropped
//! privileges, serve the hook port.

mod app;
mod collector;
mod config;
mod hooks;
mod identity;
mod process;
mod secrets;
#[cfg(test)]
mod semconv_drift;
mod semconv_gen;
mod sigv4;
mod telemetry;
mod usage;

use anyhow::{Context, Result};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use tokio::net::TcpListener;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

use config::{CollectorStart, Config};
use hooks::Agent;
use process::Reaper;

fn parse_app_command() -> Vec<String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.iter().position(|a| a == "--") {
        Some(i) => args[i + 1..].to_vec(),
        // Allow `kagero <cmd...>` without the separator too.
        None => args,
    }
}

/// HTTP client for peers inside the MicroVM or on its link-local network:
/// the app hook relay, the loopback OTLP receiver, the collector reload
/// endpoint and the credential endpoints. HTTP(S)_PROXY / ALL_PROXY must
/// never capture these requests (AWS asks for NO_PROXY=169.254.169.254
/// for the same reason), and a redirect must not carry a hook body or a
/// credential request to another host.
fn local_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("reqwest client")
}

#[tokio::main]
async fn main() -> Result<()> {
    // JSON to stdout: failures must reach CloudWatch Logs even when the
    // collector path is down (microvms.md §7).
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let app_command = parse_app_command();
    let cfg = Config::from_env(app_command)?;
    info!(?cfg, "kagero starting");

    // PID 1: reap everything, including adopted orphans.
    let reaper = Reaper::start();

    let agent = Arc::new(Agent::new(cfg.clone(), reaper));

    // Bind before the untrusted app starts — it could otherwise take either
    // port first and answer in kagero's place. The hook port is the only
    // way hooks arrive, so failing to bind it is fatal; the admin port is
    // health only.
    let hook_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), agent.cfg.hook_port);
    let hook_listener = TcpListener::bind(hook_addr)
        .await
        .with_context(|| format!("bind hook port {hook_addr}"))?;
    let admin_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), agent.cfg.admin_port);
    let admin_listener = TcpListener::bind(admin_addr)
        .await
        .inspect_err(|e| warn!(?e, %admin_addr, "admin endpoint unavailable; continuing"))
        .ok();

    // Optional build-time collector start (ADR-005 — PoC-03/04 decides the
    // default; both modes are implemented). configure_and_ensure_running
    // is a no-op when no collector binary is configured.
    if agent.cfg.collector_start == CollectorStart::Build {
        let id = identity::Identity::default();
        let ctx = collector::RenderContext {
            identity: &id,
            secret: None,
        };
        if let Err(e) = agent
            .collector
            .configure_and_ensure_running(&agent.cfg, &ctx, agent.cfg.hook_timeout_default)
            .await
        {
            telemetry::stdout_event(
                "kagero.lifecycle.degraded",
                Some("build"),
                Some(&format!("{e:#}")),
                serde_json::Map::new(),
            );
        }
    }

    // Spawn the app with dropped privileges in its own process group.
    if let Err(e) = agent.app.start(&agent.cfg) {
        // Failing to even spawn the app is fatal at build time.
        // `{e:#}` — anyhow chains carry the OS errno; `{e}` prints only
        // the outermost context and hides e.g. ENOENT vs EPERM.
        telemetry::stdout_event(
            "kagero.app.spawn_failed",
            None,
            Some(&format!("{e:#}")),
            serde_json::Map::new(),
        );
        anyhow::bail!("app spawn: {e:#}");
    }

    // Forward container stop signals to the app, and the collector so it
    // can flush its own buffers on the way down (PID 1 duty: register the
    // handlers — unhandled signals are ignored at PID 1).
    {
        // Resolve the app pgid at signal time — a snapshot taken now would
        // go stale once the app exits, and a recycled pgid could receive
        // our SIGKILL (the pid holder is cleared by the exit watcher).
        let a = agent.clone();
        tokio::spawn(process::forward_container_signal(move || a.app.pgid(), {
            let a = agent.clone();
            move || a.collector.pgid().into_iter().collect()
        }));
    }

    // Loopback admin endpoint (health only).
    if let Some(listener) = admin_listener {
        tokio::spawn(hooks::serve_admin(agent.clone(), listener));
    }

    // The hook port: the only externally reachable endpoint.
    hooks::serve(agent, hook_listener).await
}
