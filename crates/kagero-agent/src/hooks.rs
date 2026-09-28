//! Lifecycle hook server: one inbound port, ordered relay, fixed time
//! budgets (ADR-004, microvms.md §5). Hooks arrive from Lambda at
//! POST /aws/lambda-microvms/runtime/v1/{ready,validate,run,suspend,resume,terminate}.

use crate::semconv_gen as sem;
use anyhow::Result;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio::sync::Semaphore;
use tracing::{debug, error, info, warn};

use crate::app::{App, RelayOutcome};
use crate::collector::{Collector, RenderContext};
use crate::config::{Config, PeerRule};
use crate::identity::{Identity, identity_from_run_body};
use crate::process::Reaper;
use crate::secrets::fetch_secret;
use crate::telemetry::{OtlpSender, stdout_event};
use crate::usage::Usage;

const HOOK_PREFIX: &str = "/aws/lambda-microvms/runtime/v1/";
const BUILD_HOOKS: &[&str] = &["ready", "validate"];
const RUNTIME_HOOKS: &[&str] = &["run", "suspend", "resume", "terminate"];
/// Hooks a MicroVM receives many times — every suspend/resume cycle must
/// run the full relay+flush again, so they are never deduplicated.
const REPEATABLE_HOOKS: &[&str] = &["suspend", "resume"];
/// Cap concurrent hook connections so an untrusted app flooding the port
/// can't exhaust PID 1's file descriptors.
const MAX_CONN: usize = 32;
/// Request body cap — runHookPayload is small; huge bodies are hostile.
const MAX_BODY: usize = 1 << 20;

/// Status code and JSON body Lambda sees, plus the `kagero.hook.status`
/// the hook-result counter records.
type HookReply = (StatusCode, Value, sem::HookStatus);

pub struct Agent {
    pub cfg: Config,
    pub app: App,
    pub collector: Collector,
    pub usage: std::sync::Arc<Usage>,
    pub otlp: std::sync::Arc<OtlpSender>,
    identity: Mutex<Identity>,
    secret: Mutex<Option<String>>,
    /// First successful result per non-repeatable hook — replayed verbatim
    /// on retries, so a duplicate hook never double-runs side effects.
    done_results: Mutex<HashMap<String, (StatusCode, Value)>>,
    sampler_started: AtomicBool,
    serialize: tokio::sync::Mutex<()>,
}

impl Agent {
    pub fn new(cfg: Config, reaper: &'static Reaper) -> Self {
        let otlp = std::sync::Arc::new(OtlpSender::new(
            format!("http://127.0.0.1:{}", cfg.otlp_port),
            Duration::from_secs(5),
        ));
        Self {
            usage: Usage::new(
                cfg.cgroup_path.as_deref(),
                cfg.baseline_vcpu,
                cfg.baseline_gib,
            ),
            cfg,
            app: App::new(reaper),
            collector: Collector::new(reaper),
            otlp,
            identity: Mutex::new(Identity::default()),
            secret: Mutex::new(None),
            done_results: Mutex::new(HashMap::new()),
            sampler_started: AtomicBool::new(false),
            serialize: tokio::sync::Mutex::new(()),
        }
    }

    /// Record a degraded step: stdout (always) + OTLP lifecycle event
    /// (best effort, bounded by the hook's remaining deadline —
    /// lifecycle_event is two serial POSTs, so a hard 2s cap per call
    /// would let repeated degrades overshoot the hook budget; the
    /// "always answer before the cap" contract applies here too).
    async fn degraded(&self, hook: &str, err: &str, deadline: Instant) {
        let mut extra = Map::new();
        extra.insert("reason".into(), Value::String(err.to_string()));
        stdout_event(
            "kagero.lifecycle.degraded",
            Some(hook),
            Some(err),
            extra.clone(),
        );
        let budget = self.remaining(deadline).min(Duration::from_secs(2));
        if budget.is_zero() {
            return; // stdout record is already written
        }
        // The error string is high-cardinality — it lands on the LOG only;
        // lifecycle_event keeps the metric datapoint label-free (ADR-008).
        let attrs = vec![crate::telemetry::attr(sem::ATTR_KAGERO_ERROR, err)];
        if let Err(e) = self
            .otlp
            .lifecycle_event(sem::LifecycleEvent::Degraded.as_str(), &attrs, budget)
            .await
        {
            stdout_event(
                "kagero.lifecycle.degraded.otlp_failed",
                Some(hook),
                Some(&format!("{e:#}")),
                extra,
            );
        }
    }

    /// Whole-hook processing; serialized so Lambda's hooks run one at a time.
    /// The deadline is created BEFORE the serialize lock — Lambda's hook
    /// clock starts when it POSTs, and time spent queued behind an earlier
    /// hook must count against this hook's budget (§5-2).
    pub async fn handle_hook(&self, hook: &str, body: &[u8]) -> (StatusCode, Value) {
        let deadline = Instant::now() + self.cfg.hook_timeout(hook);
        let _serial = self.serialize.lock().await;
        // Replay the first successful verdict on retries; a FAILED first
        // attempt is deliberately re-runnable (Lambda may retry after a
        // timeout — returning "already_processed" would lie).
        let repeatable = REPEATABLE_HOOKS.contains(&hook);
        if !repeatable
            && let Ok(done) = self.done_results.lock()
            && let Some((code, payload)) = done.get(hook)
        {
            info!(hook, "duplicate hook; replaying first result");
            return (*code, payload.clone());
        }

        let (code, payload, status) = match hook {
            "ready" | "validate" => self.handle_build_hook(hook, body, deadline).await,
            "run" => self.handle_run(body, deadline).await,
            "suspend" => self.handle_suspend(body, deadline).await,
            "resume" => self.handle_resume(body, deadline).await,
            "terminate" => self.handle_terminate(body, deadline).await,
            // route() pre-filters unknown hooks, so this is unreachable
            // today — return 404 rather than unreachable!() anyway: a
            // panic here would take down PID 1 if a future caller
            // bypasses route()'s filter.
            _ => (
                StatusCode::NOT_FOUND,
                json!({"error": "unknown hook"}),
                sem::HookStatus::Error,
            ),
        };
        if !repeatable
            && code.is_success()
            && let Ok(mut done) = self.done_results.lock()
        {
            done.insert(hook.to_string(), (code, payload.clone()));
        }

        // Hook outcome counter — best effort; lifecycle events already
        // carry the alerting surface for failures. Capped at 2s and
        // skipped entirely when the hook budget is already spent (a
        // zero-timeout POST would just inflate the failure counter).
        if RUNTIME_HOOKS.contains(&hook) {
            let budget = self.remaining(deadline).min(Duration::from_secs(2));
            if !budget.is_zero() {
                let _ = self.otlp.hook_result(hook, status, budget).await;
            }
        }

        let mut extra: Map<String, Value> = [("status".into(), Value::from(code.as_u16()))]
            .into_iter()
            .collect();
        if let Ok(id) = self.identity.lock()
            && !id.microvm_id.is_empty()
        {
            extra.insert(
                sem::ATTR_SERVICE_INSTANCE_ID.into(),
                Value::String(id.microvm_id.clone()),
            );
        }
        stdout_event("kagero.hook.result", Some(hook), None, extra);
        (code, payload)
    }

    /// Time left before Lambda's hook deadline — every outbound call kagero
    /// makes must be bounded by this, or a stalled peer hangs the queue of
    /// subsequent hooks (design §5-2: 上限を過ぎる前に必ず返事をする).
    fn remaining(&self, deadline: Instant) -> Duration {
        deadline.saturating_duration_since(Instant::now())
    }

    async fn relay_to_app(&self, hook: &str, body: &[u8], deadline: Instant) -> RelayOutcome {
        let budget = self
            .cfg
            .app_budget(hook)
            .min(deadline.saturating_duration_since(Instant::now()));
        let path = format!("{HOOK_PREFIX}{hook}");
        let out = self
            .app
            .relay(self.cfg.app_hook_port, &path, body, budget, deadline)
            .await;
        // Deliberately NOT `?out` — RelayOutcome::Failed carries the app's
        // response body, which may echo runHookPayload (ADR-011).
        debug!(hook, outcome = app_result_str(&out), "app relay finished");
        out
    }

    /// /ready and /validate: app first, then kagero's own build checks.
    /// Failures fail the build (fail-stop), unlike runtime hooks.
    async fn handle_build_hook(&self, hook: &str, body: &[u8], deadline: Instant) -> HookReply {
        let out = self.relay_to_app(hook, body, deadline).await;
        if matches!(out, RelayOutcome::TimedOut(_) | RelayOutcome::Failed(_, _)) {
            return self.app_response(out);
        }
        // kagero-side build check: the collector template must render.
        if let Err(e) = self.build_check() {
            error!(?e, hook, "kagero build check failed");
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                json!({"kagero_error": format!("{e:#}")}),
                sem::HookStatus::Error,
            );
        }
        (StatusCode::OK, json!({"status": "ok"}), hook_status(&out))
    }

    fn build_check(&self) -> Result<()> {
        // Only relevant when a collector is configured — supervisor-only
        // images don't carry a template and must not fail /ready.
        if self.cfg.collector_bin.is_none() {
            return Ok(());
        }
        // Quiesce rule: nothing unique exists yet — identity must be empty.
        let template = std::fs::read_to_string(&self.cfg.collector_config_template)?;
        let id = Identity::default();
        let ctx = RenderContext {
            identity: &id,
            secret: None,
        };
        let rendered = crate::collector::render_template(&template, &self.cfg, &ctx);
        // Match kagero placeholders only — the collector's own template
        // syntax may legitimately contain "{{" (e.g. Alloy components).
        if rendered.contains("{{KAGERO_") {
            anyhow::bail!("collector template has unresolved KAGERO placeholders");
        }
        Ok(())
    }

    /// The hook response Lambda sees: the app's verdict on success, a 502
    /// carrying its error body otherwise.
    fn app_response(&self, out: RelayOutcome) -> HookReply {
        let status = hook_status(&out);
        match out {
            RelayOutcome::Failed(code, text) => (
                StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_GATEWAY),
                json!({"app_error": text}),
                status,
            ),
            RelayOutcome::TimedOut(text) => {
                (StatusCode::BAD_GATEWAY, json!({"app_error": text}), status)
            }
            RelayOutcome::Ok | RelayOutcome::Unimplemented | RelayOutcome::NoListener => (
                StatusCode::OK,
                json!({"status": "ok", "app_exited": self.app.had_exited()}),
                status,
            ),
        }
    }

    /// /run: kagero first (identity → secrets → collector → usage → run event),
    /// then relay to the app so its first telemetry already carries identity.
    async fn handle_run(&self, body: &[u8], deadline: Instant) -> HookReply {
        let parsed: Value = match serde_json::from_slice(body) {
            Ok(v) => v,
            Err(e) => {
                self.degraded("run", &format!("bad /run body: {e:#}"), deadline)
                    .await;
                return (
                    StatusCode::BAD_REQUEST,
                    json!({"error": "invalid json"}),
                    sem::HookStatus::Error,
                );
            }
        };
        let id = identity_from_run_body(
            &parsed,
            self.cfg.tenant_pointer.as_deref(),
            self.cfg.session_pointer.as_deref(),
        );
        if id.microvm_id.is_empty() {
            self.degraded("run", "run hook body had no microvmId", deadline)
                .await;
        }
        if let Ok(mut g) = self.identity.lock() {
            *g = id.clone();
        }

        // 1. Fetch secrets (ADR-011). Only when configured — CloudWatch
        // backend needs none (execution-role SigV4 happens in the collector).
        if let Some(arn) = &self.cfg.secret_arn {
            match fetch_secret(
                &self.cfg.imds_endpoint,
                self.cfg.secrets_endpoint.as_deref(),
                &self.cfg.region,
                arn,
                deadline,
            )
            .await
            {
                Ok(s) => {
                    if let Ok(mut g) = self.secret.lock() {
                        *g = Some(s);
                    }
                }
                Err(e) => {
                    self.degraded("run", &format!("secret fetch: {e:#}"), deadline)
                        .await
                }
            }
        }

        // 2. Collector config + start/reload. Extract owned values first —
        // std MutexGuards are !Send and must not live across .await.
        {
            let id_owned = self
                .identity
                .lock()
                .ok()
                .map(|g| g.clone())
                .unwrap_or_default();
            let secret_owned = self.secret.lock().ok().and_then(|g| g.clone());
            let ctx = RenderContext {
                identity: &id_owned,
                secret: secret_owned.as_deref(),
            };
            if let Err(e) = self
                .collector
                .configure_and_ensure_running(&self.cfg, &ctx, self.remaining(deadline))
                .await
            {
                self.degraded("run", &format!("collector: {e:#}"), deadline)
                    .await;
            }
        }

        // 3. Usage accounting enters RUNNING.
        self.usage.set_running(true);
        if !self.sampler_started.swap(true, Ordering::SeqCst) {
            self.usage.spawn_sampler(
                self.cfg.sample_interval,
                std::sync::Arc::clone(&self.otlp),
                crate::usage::USAGE_PUSH_INTERVAL,
            );
        }

        // 4. Relay to the app; the app's result is what Lambda sees.
        let app_out = self.relay_to_app("run", body, deadline).await;

        // 5. Lifecycle event after the relay verdict (microvms.md §4-2
        // sequence) — it records the run as the app actually answered it.
        let mut attrs = vec![crate::telemetry::attr(
            sem::ATTR_KAGERO_APP_RESULT,
            app_result_str(&app_out),
        )];
        if self.app.had_exited() {
            attrs.push(crate::telemetry::attr(sem::ATTR_KAGERO_APP_EXITED, true));
        }
        if let Err(e) = self
            .otlp
            .lifecycle_event(
                sem::LifecycleEvent::Run.as_str(),
                &attrs,
                self.remaining(deadline),
            )
            .await
        {
            self.degraded("run", &format!("lifecycle event: {e:#}"), deadline)
                .await;
        }

        self.app_response(app_out)
    }

    /// /suspend: app first (flush), then kagero sends the usage summary and
    /// the suspend event with synchronous export (ADR-006).
    async fn handle_suspend(&self, body: &[u8], deadline: Instant) -> HookReply {
        let app_out = self.relay_to_app("suspend", body, deadline).await;

        self.usage.mark_suspend().await;
        if let Err(e) = self.send_usage_summary("suspend", deadline).await {
            self.degraded("suspend", &format!("usage summary: {e:#}"), deadline)
                .await;
        }
        if let Err(e) = self
            .otlp
            .lifecycle_event(
                sem::LifecycleEvent::Suspend.as_str(),
                &[],
                self.remaining(deadline),
            )
            .await
        {
            self.degraded("suspend", &format!("lifecycle event: {e:#}"), deadline)
                .await;
        }

        self.app_response(app_out)
    }

    /// /resume: kagero first (bookkeeping → reconnect), then app, then the
    /// lifecycle event records what actually happened (§4-3 sequence).
    async fn handle_resume(&self, body: &[u8], deadline: Instant) -> HookReply {
        let suspended_secs = self.usage.mark_resume().await;

        // Clock skew: a huge delta indicates the wall clock is not settled
        // yet; surface it instead of hiding it (microvms.md §6).
        if suspended_secs > 86_400.0 {
            self.degraded(
                "resume",
                &format!("implausible suspend duration {suspended_secs}s"),
                deadline,
            )
            .await;
        }

        // Reconnect the collector: its sockets died with the suspend.
        // Capped at 5s — a wedged reload endpoint must not eat the whole
        // remaining budget and starve the app relay below.
        if self.collector.is_running()
            && let Err(e) = self
                .collector
                .reload(
                    &self.cfg,
                    self.remaining(deadline).min(Duration::from_secs(5)),
                )
                .await
        {
            self.degraded("resume", &format!("collector reconnect: {e:#}"), deadline)
                .await;
        }

        let app_out = self.relay_to_app("resume", body, deadline).await;

        let (h_count, h_sum, h_buckets) = self.usage.suspend_histogram().await;
        if let Err(e) = self
            .otlp
            .suspend_duration(
                h_count,
                h_sum,
                &h_buckets,
                &crate::usage::SUSPEND_BOUNDS,
                self.remaining(deadline),
            )
            .await
        {
            self.degraded("resume", &format!("suspend metric: {e:#}"), deadline)
                .await;
        }
        // Duration value stays on the LOG — it is forbidden as a metric
        // label (it would mint a new series per resume).
        let attrs = vec![
            crate::telemetry::attr(sem::ATTR_KAGERO_SUSPEND_DURATION_SECONDS, suspended_secs),
            crate::telemetry::attr(sem::ATTR_KAGERO_APP_RESULT, app_result_str(&app_out)),
        ];
        if let Err(e) = self
            .otlp
            .lifecycle_event(
                sem::LifecycleEvent::Resume.as_str(),
                &attrs,
                self.remaining(deadline),
            )
            .await
        {
            self.degraded("resume", &format!("lifecycle event: {e:#}"), deadline)
                .await;
        }

        self.app_response(app_out)
    }

    /// /terminate: app first (flush), then final summary + terminate event,
    /// then SIGTERM the collector and the app (ADR-006 order).
    async fn handle_terminate(&self, body: &[u8], deadline: Instant) -> HookReply {
        let app_out = self.relay_to_app("terminate", body, deadline).await;

        // Close any open suspend interval before the final accounting.
        self.usage.finalize().await;
        if let Err(e) = self.send_usage_summary("terminate", deadline).await {
            self.degraded("terminate", &format!("usage summary: {e:#}"), deadline)
                .await;
        }
        if let Err(e) = self
            .otlp
            .lifecycle_event(
                sem::LifecycleEvent::Terminate.as_str(),
                &[],
                self.remaining(deadline),
            )
            .await
        {
            self.degraded("terminate", &format!("lifecycle event: {e:#}"), deadline)
                .await;
        }
        // Telemetry is out — now the app and collector may stop.
        // SIGTERM, then a bounded wait for exit, then SIGKILL the group —
        // an app that ignores SIGTERM must not outlive a successful
        // /terminate hook (ADR-006: this hook ends the MicroVM's life).
        self.app.expect_exit();
        if let Some(pg) = self.app.pgid() {
            let _ = crate::process::kill_group(pg, libc::SIGTERM);
            let grace = self.remaining(deadline).min(crate::process::SIGTERM_GRACE);
            let until = Instant::now() + grace;
            // Wait on the whole process GROUP, not just the leader — a
            // leader that exits while its children still flush must not
            // cut the grace short or skip the escalation check.
            while crate::process::group_alive(pg) && Instant::now() < until {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            if crate::process::group_alive(pg) {
                warn!("app ignored SIGTERM; escalating to SIGKILL");
                let _ = crate::process::kill_group(pg, libc::SIGKILL);
            }
        }
        if let Err(e) = self.collector.stop(self.remaining(deadline)).await {
            self.degraded("terminate", &format!("collector stop: {e:#}"), deadline)
                .await;
        }

        self.app_response(app_out)
    }

    /// The per-instance cost record: usage facts + identity on a log
    /// (microvms.md §9 要約ログ). Metrics stay ID-free (ADR-008).
    /// Each POST recomputes the time left — sharing one budget across
    /// sequential requests could overrun the hook deadline (3×timeout).
    async fn send_usage_summary(&self, cause: &str, deadline: Instant) -> Result<()> {
        let snap = self.usage.snapshot().await;
        let id = self
            .identity
            .lock()
            .map_err(|_| anyhow::anyhow!("id lock"))?
            .clone();

        // metrics (allowed labels only — none here; collector stamps them)
        self.otlp
            .usage_metrics(
                snap.running_seconds,
                snap.burst_vcpu_seconds,
                snap.burst_gib_seconds,
                self.remaining(deadline),
            )
            .await?;

        // Suspend-duration histogram — finalize() may have just closed an
        // open interval, so emit the updated distribution too.
        self.otlp
            .suspend_duration(
                snap.suspend_count,
                snap.suspend_sum,
                &snap.suspend_buckets,
                &crate::usage::SUSPEND_BOUNDS,
                self.remaining(deadline),
            )
            .await?;

        // summary log with the identifying attributes
        let mut fields = Map::new();
        fields.insert(
            sem::ATTR_KAGERO_USAGE_CAUSE.into(),
            Value::String(cause.into()),
        );
        fields.insert(
            sem::ATTR_SERVICE_INSTANCE_ID.into(),
            Value::String(id.microvm_id.clone()),
        );
        if let Some(t) = &id.tenant_id {
            fields.insert(sem::ATTR_KAGERO_TENANT_ID.into(), Value::String(t.clone()));
        }
        if let Some(s) = &id.session_id {
            fields.insert(sem::ATTR_KAGERO_SESSION_ID.into(), Value::String(s.clone()));
        }
        fields.insert(
            sem::ATTR_KAGERO_USAGE_RUNNING_SECONDS.into(),
            json!(snap.running_seconds),
        );
        fields.insert(
            sem::ATTR_KAGERO_USAGE_BURST_VCPU_SECONDS.into(),
            json!(snap.burst_vcpu_seconds),
        );
        fields.insert(
            sem::ATTR_KAGERO_USAGE_BURST_GIB_SECONDS.into(),
            json!(snap.burst_gib_seconds),
        );
        fields.insert(
            sem::ATTR_KAGERO_USAGE_SUSPEND_SECONDS.into(),
            json!(snap.suspend_sum),
        );
        fields.insert(sem::ATTR_KAGERO_USAGE_SUSPENDS.into(), json!(snap.suspends));
        fields.insert(sem::ATTR_KAGERO_USAGE_RESUMES.into(), json!(snap.resumes));
        self.otlp
            .usage_summary_log(&fields, self.remaining(deadline))
            .await
    }
}

/// One-word app relay verdict for the lifecycle-event LOG attribute —
/// registry-verified values via the generated enum.
fn app_result_str(o: &RelayOutcome) -> &'static str {
    match o {
        RelayOutcome::Ok => sem::AppResult::Ok,
        RelayOutcome::Unimplemented => sem::AppResult::Unimplemented,
        RelayOutcome::NoListener => sem::AppResult::NoListener,
        RelayOutcome::TimedOut(_) | RelayOutcome::Failed(_, _) => sem::AppResult::Failed,
    }
    .as_str()
}

/// `kagero.hook.status` for the hook-result counter. A hook-less app
/// (404 or nothing listening) counts as unimplemented, not as ok.
fn hook_status(o: &RelayOutcome) -> sem::HookStatus {
    match o {
        RelayOutcome::Ok => sem::HookStatus::Ok,
        RelayOutcome::Unimplemented | RelayOutcome::NoListener => sem::HookStatus::Unimplemented,
        RelayOutcome::TimedOut(_) => sem::HookStatus::Timeout,
        RelayOutcome::Failed(_, _) => sem::HookStatus::Error,
    }
}

/// Whether `ip` may call the hook port.
fn peer_allowed(allow: &[PeerRule], ip: IpAddr) -> bool {
    if allow.is_empty() {
        // No allowlist: the strongest safe default is denying loopback —
        // only the in-VM app can appear as one. The app could still forge
        // via the VM's own primary IP; closing that needs the real source
        // list (PoC-02).
        !ip.is_loopback()
    } else {
        allow.iter().any(|p| p.contains(&ip))
    }
}

/// Serve the hook endpoint on `listener` until the process dies.
/// `accept()` failures are logged and retried with backoff — propagating an
/// error here would kill PID 1 (and the whole MicroVM) on e.g. EMFILE from
/// a hostile peer, and the untrusted app can reach this port.
pub async fn serve(agent: std::sync::Arc<Agent>, listener: TcpListener) -> ! {
    let conn_cap = std::sync::Arc::new(Semaphore::new(MAX_CONN));
    let allow = agent.cfg.hook_allowed_peers.clone();
    if allow.is_empty() {
        warn!(
            "KAGERO_HOOK_ALLOWED_PEERS unset — rejecting loopback peers only. \
               A loopback source can only be the in-VM app, which is untrusted \
               (it could forge /terminate). Genuine hooks arrive from outside \
               the MicroVM; set the allowlist once PoC-02 confirms Lambda's \
               source addresses"
        );
    }
    if let Ok(addr) = listener.local_addr() {
        info!(%addr, "hook server listening");
    }
    // A connection can never legitimately outlive its request's hook
    // deadline (+slack for header/body transit). Keep-alive is off —
    // hooks are rare lifecycle calls, and an idle keep-alive connection
    // would pin one of MAX_CONN slots forever (the untrusted app can
    // reach this port via the VM's primary IP when the allowlist is
    // empty). Edge case: a request queued behind a *longer-timeout*
    // hook can see conn_life elapse mid-handling — the connection is
    // then dropped while the handler still answers internally; for
    // Lambda's serialized delivery this never occurs (one hook at a
    // time), and for an allowed-peer flood, dropping is the intent.
    let conn_life = BUILD_HOOKS
        .iter()
        .chain(RUNTIME_HOOKS)
        .map(|h| agent.cfg.hook_timeout(h))
        .max()
        .expect("hook tables are non-empty")
        * 2
        + Duration::from_secs(5);
    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                if !peer_allowed(&allow, peer.ip()) {
                    warn!(%peer, "hook connection from disallowed peer, dropping");
                    continue;
                }
                debug!(%peer, "hook connection");
                // Drop the connection when the table is full — better than
                // blocking accept() and starving Lambda's delivery.
                let Ok(permit) = conn_cap.clone().try_acquire_owned() else {
                    warn!(%peer, "hook connection limit reached, dropping");
                    continue;
                };
                let agent = agent.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    let svc = service_fn(move |req: Request<Incoming>| {
                        let agent = agent.clone();
                        async move { route(agent, req).await }
                    });
                    serve_http1(stream, svc, conn_life, peer).await;
                });
            }
            Err(e) => {
                warn!(?e, "hook accept failed; continuing");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
}

async fn route<B>(
    agent: std::sync::Arc<Agent>,
    req: Request<B>,
) -> Result<Response<Full<Bytes>>, hyper::Error>
where
    B: hyper::body::Body,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    let path = req.uri().path().to_string();
    if req.method() != Method::POST || !path.starts_with(HOOK_PREFIX) {
        return Ok(resp(StatusCode::NOT_FOUND, json!({"error": "not found"})));
    }
    let hook = &path[HOOK_PREFIX.len()..];
    // Unknown hooks get their 404 BEFORE the body read and the serialize
    // lock — a hostile peer spraying bogus paths must not queue behind
    // in-flight lifecycle work or burn a body-read timeout slot.
    if !BUILD_HOOKS.contains(&hook) && !RUNTIME_HOOKS.contains(&hook) {
        return Ok(resp(
            StatusCode::NOT_FOUND,
            json!({"error": "unknown hook"}),
        ));
    }
    // Bounded collect — this port is reachable by untrusted code and an
    // unbounded body would eat PID 1's memory. The READ is also bounded
    // in time by the hook's own timeout: the deadline inside handle_hook
    // only starts once the body is complete, so a slow-drip peer would
    // otherwise hold a connection slot forever.
    let collected = tokio::time::timeout(
        agent.cfg.hook_timeout(hook),
        Limited::new(req.into_body(), MAX_BODY).collect(),
    )
    .await;
    let body = match collected {
        Ok(Ok(c)) => c.to_bytes(),
        Ok(Err(_)) => {
            return Ok(resp(
                StatusCode::PAYLOAD_TOO_LARGE,
                json!({"error": "body too large"}),
            ));
        }
        Err(_) => {
            return Ok(resp(
                StatusCode::REQUEST_TIMEOUT,
                json!({"error": "body read timed out"}),
            ));
        }
    };

    let (status, payload) = agent.handle_hook(hook, &body).await;
    Ok(resp(status, payload))
}

fn resp(status: StatusCode, payload: Value) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(payload.to_string())))
        .unwrap_or_else(|_| Response::new(Full::new(Bytes::from_static(b"{}"))))
}

/// Serve one accepted connection as HTTP/1 with keep-alive off and a hard
/// lifetime cap — shared by the hook port and the admin port, both of
/// which are reachable by the untrusted app.
async fn serve_http1<S>(
    stream: tokio::net::TcpStream,
    svc: S,
    conn_life: Duration,
    peer: SocketAddr,
) where
    S: hyper::service::Service<
            Request<Incoming>,
            Response = Response<Full<Bytes>>,
            Error = hyper::Error,
        > + Send
        + 'static,
    S::Future: Send,
{
    let io = TokioIo::new(stream);
    // HTTP/1 only — the runtime and the admin poller are plain loopback
    // clients; skipping the h2 machinery keeps the dependency tree smaller.
    let mut h1 = hyper::server::conn::http1::Builder::new();
    h1.keep_alive(false);
    match tokio::time::timeout(conn_life, h1.serve_connection(io, svc)).await {
        Ok(Err(e)) => debug!(?e, "connection closed with error"),
        Err(_) => debug!(%peer, "connection lifetime exceeded, dropping"),
        Ok(Ok(())) => {}
    }
}

/// Tiny admin server on loopback: every path returns liveness plus the
/// count of failed OTLP posts so far (PoC-04 measurement aid).
/// The loopback bind is NOT a trust boundary — the untrusted app can
/// reach it — so it gets the same connection hygiene as the hook port:
/// bounded concurrency, no keep-alive, capped lifetime.
pub async fn serve_admin(agent: std::sync::Arc<Agent>, listener: TcpListener) -> ! {
    let conn_cap = std::sync::Arc::new(Semaphore::new(8));
    const CONN_LIFE: Duration = Duration::from_secs(10);
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(x) => x,
            Err(e) => {
                warn!(?e, "admin accept failed; continuing");
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        let Ok(permit) = conn_cap.clone().try_acquire_owned() else {
            continue; // drop the connection — the table is full
        };
        let agent = agent.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let svc = service_fn(move |_req| {
                let agent = agent.clone();
                async move {
                    Ok::<_, hyper::Error>(resp(
                        StatusCode::OK,
                        json!({
                            "status": "up",
                            "otlp_failures": agent.otlp.failure_count(),
                        }),
                    ))
                }
            });
            serve_http1(stream, svc, CONN_LIFE, peer).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::tests::fake_app;
    use std::pin::Pin;
    use std::sync::Arc;
    use std::task::{Context, Poll};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const APP_OK: &str = "HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";
    const APP_FAIL: &str =
        "HTTP/1.1 500 Internal Server Error\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";

    /// A loopback port nothing listens on: OTLP posts and relays sent
    /// there fail fast instead of reaching a real local service.
    fn closed_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    fn agent(edit: impl FnOnce(&mut Config)) -> Arc<Agent> {
        let mut cfg = crate::config::fixture();
        cfg.otlp_port = closed_port();
        cfg.app_hook_port = closed_port();
        edit(&mut cfg);
        Arc::new(Agent::new(cfg, Reaper::idle()))
    }

    fn post<B>(hook: &str, body: B) -> Request<B> {
        Request::post(format!("{HOOK_PREFIX}{hook}"))
            .body(body)
            .unwrap()
    }

    /// A request body that never delivers a byte.
    struct Stalled;

    impl hyper::body::Body for Stalled {
        type Data = Bytes;
        type Error = std::convert::Infallible;

        fn poll_frame(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
        ) -> Poll<Option<Result<hyper::body::Frame<Bytes>, Self::Error>>> {
            Poll::Pending
        }
    }

    #[test]
    fn peer_allowed_denies_loopback_without_an_allowlist() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        assert!(!peer_allowed(&[], ip("127.0.0.1")));
        assert!(!peer_allowed(&[], ip("::1")));
        assert!(peer_allowed(&[], ip("10.0.0.5")));
        let listed = [PeerRule::parse("10.0.0.0/8").unwrap()];
        assert!(peer_allowed(&listed, ip("10.1.2.3")));
        assert!(!peer_allowed(&listed, ip("192.168.0.1")));
        assert!(!peer_allowed(&listed, ip("127.0.0.1")));
        let loopback = [PeerRule::parse("127.0.0.0/8").unwrap()];
        assert!(peer_allowed(&loopback, ip("127.0.0.1")));
    }

    /// The accept loop itself: a disallowed peer is closed without a
    /// single HTTP byte; an allowed one gets an answer.
    #[tokio::test]
    async fn serve_closes_disallowed_peers_before_http() {
        for (allow, answered) in [
            (vec![], false),
            (vec![PeerRule::parse("127.0.0.0/8").unwrap()], true),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            tokio::spawn(serve(agent(|c| c.hook_allowed_peers = allow), listener));
            let mut conn = tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .unwrap();
            let _ = conn
                .write_all(b"GET / HTTP/1.1\r\nhost: kagero\r\n\r\n")
                .await;
            let mut reply = Vec::new();
            let _ = tokio::time::timeout(Duration::from_secs(5), conn.read_to_end(&mut reply))
                .await
                .expect("the hook port neither answered nor closed");
            let reply = String::from_utf8_lossy(&reply);
            if answered {
                assert!(reply.starts_with("HTTP/1.1 404"), "{reply}");
            } else {
                assert!(reply.is_empty(), "{reply}");
            }
        }
    }

    #[tokio::test]
    async fn route_rejects_unknown_paths_before_reading_the_body() {
        let a = agent(|_| {});
        let get = Request::get(format!("{HOOK_PREFIX}run"))
            .body(Full::new(Bytes::new()))
            .unwrap();
        let elsewhere = Request::post("/other")
            .body(Full::new(Bytes::new()))
            .unwrap();
        for req in [get, elsewhere] {
            let status = route(a.clone(), req).await.unwrap().status();
            assert_eq!(status, StatusCode::NOT_FOUND);
        }
        // Reading the stalled body would end in 408 after the hook budget.
        let status = route(a, post("bogus", Stalled)).await.unwrap().status();
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn route_caps_the_body_size_and_read_time() {
        let a = agent(|c| {
            c.hook_timeouts
                .insert("ready".into(), Duration::from_millis(100));
        });
        let big = post("ready", Full::new(Bytes::from(vec![b'x'; MAX_BODY + 1])));
        let status = route(a.clone(), big).await.unwrap().status();
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        let status = route(a, post("ready", Stalled)).await.unwrap().status();
        assert_eq!(status, StatusCode::REQUEST_TIMEOUT);
    }

    #[tokio::test]
    async fn run_with_invalid_json_is_rejected_and_stays_rerunnable() {
        let a = agent(|_| {});
        let (code, _) = a.handle_hook("run", b"not json").await;
        assert_eq!(code, StatusCode::BAD_REQUEST);
        let (code, _) = a.handle_hook("run", br#"{"microvmId":"mvm-1"}"#).await;
        assert_eq!(code, StatusCode::OK);
    }

    #[tokio::test]
    async fn duplicate_hook_replays_the_first_success() {
        let (port, hits) = fake_app(Some(APP_OK.into())).await;
        let a = agent(|c| c.app_hook_port = port);
        let first = a.handle_hook("ready", b"{}").await;
        let second = a.handle_hook("ready", b"{}").await;
        assert_eq!(first.0, StatusCode::OK);
        assert_eq!(first, second);
        assert_eq!(hits.load(Ordering::SeqCst), 1, "a replay reached the app");
    }

    #[tokio::test]
    async fn failed_and_repeatable_hooks_run_again() {
        let (port, hits) = fake_app(Some(APP_FAIL.into())).await;
        let a = agent(|c| c.app_hook_port = port);
        for _ in 0..2 {
            let (code, _) = a.handle_hook("validate", b"{}").await;
            assert_eq!(code, StatusCode::INTERNAL_SERVER_ERROR);
        }
        assert_eq!(hits.load(Ordering::SeqCst), 2);

        let (port, hits) = fake_app(Some(APP_OK.into())).await;
        let a = agent(|c| c.app_hook_port = port);
        for _ in 0..2 {
            let (code, _) = a.handle_hook("suspend", b"{}").await;
            assert_eq!(code, StatusCode::OK);
        }
        assert_eq!(hits.load(Ordering::SeqCst), 2);
    }

    /// The counter must be able to carry every registry value of
    /// kagero.hook.status — a value the agent never sends would leave
    /// dashboards built on it empty.
    #[test]
    fn hook_status_distinguishes_every_relay_outcome() {
        assert_eq!(hook_status(&RelayOutcome::Ok), sem::HookStatus::Ok);
        assert_eq!(
            hook_status(&RelayOutcome::Unimplemented),
            sem::HookStatus::Unimplemented
        );
        assert_eq!(
            hook_status(&RelayOutcome::NoListener),
            sem::HookStatus::Unimplemented
        );
        assert_eq!(
            hook_status(&RelayOutcome::TimedOut(String::new())),
            sem::HookStatus::Timeout
        );
        assert_eq!(
            hook_status(&RelayOutcome::Failed(500, String::new())),
            sem::HookStatus::Error
        );
    }
}
