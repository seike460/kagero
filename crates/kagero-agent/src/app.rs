//! The app child process and the hook relay client.
//! The app gets its own process group and dropped privileges (microvms.md §3),
//! and hooks are relayed to it over loopback (§5-4).

use anyhow::Result;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tracing::info;

use crate::config::Config;
use crate::process::{ChildSpec, Reaper, watch_exit};

pub enum RelayOutcome {
    /// 2xx from the app.
    Ok,
    /// 404 — hooks not implemented; treated as success (microvms.md §5-3).
    Unimplemented,
    /// Connection refused — the app does not listen for hooks at all;
    /// also treated as "unimplemented" so hook-less apps work.
    NoListener,
    /// The app took the hook but did not answer within the budget.
    TimedOut(String),
    /// Any other status or transport failure — the app answered but
    /// failed, or couldn't be reached mid-request.
    Failed(u16, String),
}

pub struct App {
    pid: Arc<Mutex<Option<u32>>>,
    /// Set before a deliberate kill so the exit watcher doesn't cry crash.
    expected_exit: Arc<AtomicBool>,
    ever_started: AtomicBool,
    client: reqwest::Client,
    reaper: &'static Reaper,
}

impl App {
    pub fn new(reaper: &'static Reaper) -> Self {
        Self {
            pid: Arc::new(Mutex::new(None)),
            expected_exit: Arc::new(AtomicBool::new(false)),
            ever_started: AtomicBool::new(false),
            client: crate::local_http_client(),
            reaper,
        }
    }

    /// Process-group id — None once the child is reaped, so a recycled pid
    /// can never receive our signals.
    pub fn pgid(&self) -> Option<u32> {
        *self.pid.lock().ok()?
    }

    /// The app was started and has since exited on its own (crash).
    /// Lets hook handlers distinguish "no hooks implemented" from "dead app".
    pub fn had_exited(&self) -> bool {
        self.ever_started.load(Ordering::Relaxed)
            && self.pid.lock().map(|g| g.is_none()).unwrap_or(false)
    }

    /// Mark the app as deliberately stopping before signalling it.
    pub fn expect_exit(&self) {
        self.expected_exit.store(true, Ordering::Relaxed);
    }

    /// Spawn the app command (privileges dropped, own process group).
    pub fn start(&self, cfg: &Config) -> Result<()> {
        if cfg.app_command.is_empty() {
            info!("no app command; running supervisor-only");
            return Ok(());
        }
        let (program, args) = cfg.app_command.split_first().expect("nonempty");
        // spawn_watched registers the exit watch under the reaper's lock —
        // a fast-exiting child's status can't be dropped before we start
        // watching it.
        let pid = self.reaper.spawn_watched(&ChildSpec {
            program,
            args,
            uid: cfg.app_uid,
            gid: cfg.app_gid,
            scrub_aws_env: true,
        })?;
        *self.pid.lock().map_err(|_| anyhow::anyhow!("app lock"))? = Some(pid);
        self.ever_started.store(true, Ordering::Relaxed);
        info!(pid, ?program, "app started");
        watch_exit(
            self.reaper,
            pid,
            "app",
            self.pid.clone(),
            self.expected_exit.clone(),
        );
        Ok(())
    }

    /// POST the hook to the app unchanged. `body` is the raw request body —
    /// runHookPayload is passed through, never modified or logged (§5-3).
    /// `deadline` is the hook's absolute deadline: the error-body read is
    /// bounded by the REMAINING budget at read time, not the entry-time
    /// budget — a slow-drip response must not overrun Lambda's clock.
    pub async fn relay(
        &self,
        app_port: u16,
        hook_path: &str,
        body: &[u8],
        budget: Duration,
        deadline: Instant,
    ) -> RelayOutcome {
        let url = format!("http://127.0.0.1:{app_port}{hook_path}");
        let res = self
            .client
            .post(url)
            .header("content-type", "application/json")
            .body(body.to_vec())
            .timeout(budget)
            .send()
            .await;
        match res {
            Ok(mut r) => {
                let code = r.status().as_u16();
                if code == 404 {
                    RelayOutcome::Unimplemented
                } else if r.status().is_success() {
                    RelayOutcome::Ok
                } else {
                    // The app is untrusted — a giant or slow-drip error
                    // body must not exhaust PID 1's memory or the hook
                    // budget. Cap both size and read time.
                    const MAX_ERR_BODY: usize = 8 * 1024;
                    let read = async {
                        let mut buf: Vec<u8> = Vec::new();
                        while let Ok(Some(b)) = r.chunk().await {
                            if buf.len() + b.len() >= MAX_ERR_BODY {
                                let room = MAX_ERR_BODY - buf.len();
                                buf.extend_from_slice(&b[..room]);
                                break;
                            }
                            buf.extend_from_slice(&b);
                        }
                        buf
                    };
                    let left = deadline.saturating_duration_since(Instant::now());
                    let buf = tokio::time::timeout(left.min(Duration::from_secs(2)), read)
                        .await
                        .unwrap_or_default();
                    RelayOutcome::Failed(code, String::from_utf8_lossy(&buf).into_owned())
                }
            }
            Err(e) => {
                if e.is_connect() {
                    RelayOutcome::NoListener
                } else if e.is_timeout() {
                    RelayOutcome::TimedOut(e.to_string())
                } else {
                    RelayOutcome::Failed(0, e.to_string())
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const HOOK: &str = "/aws/lambda-microvms/runtime/v1/run";

    /// A loopback "app" that reads each request and answers with
    /// `response` (None = never answer). Returns its port and the number
    /// of connections it accepted.
    async fn fake_app(response: Option<String>) -> (u16, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                counter.fetch_add(1, Ordering::SeqCst);
                let response = response.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 1024];
                    while !buf.ends_with(b"\r\n\r\n{}") {
                        match stream.read(&mut chunk).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        }
                    }
                    match response {
                        Some(r) => {
                            let _ = stream.write_all(r.as_bytes()).await;
                        }
                        None => tokio::time::sleep(Duration::from_secs(30)).await,
                    }
                });
            }
        });
        (port, hits)
    }

    async fn relay(port: u16, budget: Duration) -> RelayOutcome {
        App::new(crate::process::Reaper::idle())
            .relay(port, HOOK, b"{}", budget, Instant::now() + budget)
            .await
    }

    #[tokio::test]
    async fn relay_never_follows_a_redirect() {
        let (elsewhere, elsewhere_hits) = fake_app(Some(
            "HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".into(),
        ))
        .await;
        let (app, _) = fake_app(Some(format!(
            "HTTP/1.1 307 Temporary Redirect\r\nlocation: http://127.0.0.1:{elsewhere}{HOOK}\r\n\
             content-length: 0\r\nconnection: close\r\n\r\n"
        )))
        .await;
        let out = relay(app, Duration::from_secs(5)).await;
        assert!(matches!(out, RelayOutcome::Failed(307, _)));
        assert_eq!(elsewhere_hits.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn relay_reports_a_silent_app_as_timed_out() {
        let (app, _) = fake_app(None).await;
        let out = relay(app, Duration::from_millis(200)).await;
        assert!(matches!(out, RelayOutcome::TimedOut(_)));
    }

    #[tokio::test]
    async fn relay_reports_404_as_unimplemented() {
        let (app, _) = fake_app(Some(
            "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".into(),
        ))
        .await;
        let out = relay(app, Duration::from_secs(5)).await;
        assert!(matches!(out, RelayOutcome::Unimplemented));
    }
}
