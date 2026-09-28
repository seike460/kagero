//! PID 1 responsibilities: spawn supervised children in their own process
//! groups, reap *all* zombies (including adopted orphans), and forward
//! container signals to the app.

use std::collections::{HashMap, HashSet};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result};
use tracing::{debug, info, warn};

#[derive(Debug, Clone, Copy)]
pub struct ChildSpec<'a> {
    pub program: &'a str,
    pub args: &'a [String],
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    /// Remove AWS credential env vars before exec — the untrusted app must
    /// not inherit the execution-role credential surface (threat model).
    pub scrub_aws_env: bool,
}

/// Env vars that would hand AWS credentials to a child. Non-secret config
/// (KAGERO_*, image env) passes through; only credential carriers go.
const AWS_CRED_ENV: &[&str] = &[
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_SECURITY_TOKEN",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_ROLE_ARN",
    "AWS_ROLE_SESSION_NAME",
    "AWS_PROFILE",
    "AWS_DEFAULT_PROFILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CONFIG_FILE",
];

/// Spawn a supervised child. Returns the pid; exit status arrives via the
/// global [`Reaper`] — never call `wait()` on a std::process::Child here,
/// the reaper owns all waitpid calls.
pub fn spawn(spec: &ChildSpec) -> Result<u32> {
    let mut cmd = Command::new(spec.program);
    cmd.args(spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    if spec.scrub_aws_env {
        for k in AWS_CRED_ENV {
            cmd.env_remove(k);
        }
    }
    // Privilege drop happens entirely inside pre_exec — NOT via
    // Command::uid()/gid(). std applies those BEFORE user pre_exec
    // closures on this platform, so a pre_exec setgroups() would run
    // already unprivileged and fail EPERM (verified: musl container
    // spawn died with "Operation not permitted"). Our own order must be
    // setgroups → setgid → setuid, all while still root.
    let drop_groups = spec.uid.is_some() || spec.gid.is_some();
    let uid = spec.uid;
    // gid falls back to uid: uid-only must not leave egid=0 on the
    // untrusted child (mirrors config.rs's `app_gid.or(app_uid)`).
    let gid = spec.gid.or(spec.uid);
    unsafe {
        cmd.pre_exec(move || {
            // Every supervised child leads its own process group — signals
            // (SIGTERM/SIGKILL escalation) target it alone.
            if libc::setpgid(0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            if drop_groups {
                // Drop supplementary groups FIRST — without this a
                // root agent's group memberships (e.g. wheel) leak
                // into the dropped-priv child. Must run while the
                // child still holds CAP_SETGID. A non-root agent
                // cannot clear them — spawn fails closed rather
                // than leaking memberships into untrusted code.
                if libc::setgroups(0, std::ptr::null()) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if let Some(g) = gid
                    && libc::setgid(g) != 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                if let Some(u) = uid
                    && libc::setuid(u) != 0
                {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    let child = cmd
        .spawn()
        .with_context(|| format!("spawn {}", spec.program))?;
    let pid = child.id();
    // Drop the std::process::Child WITHOUT waiting — the Reaper reaps it.
    std::mem::forget(child);
    Ok(pid)
}

pub fn kill(pid: u32, sig: i32) -> Result<()> {
    let rc = unsafe { libc::kill(pid as i32, sig) };
    if rc != 0 {
        let err = std::io::Error::last_os_error();
        // ESRCH: already gone — not an error for shutdown paths.
        if err.raw_os_error() != Some(libc::ESRCH) {
            anyhow::bail!("kill({pid}, {sig}): {err}");
        }
    }
    Ok(())
}

/// Signal an entire process group (negative pid semantics via killpg).
pub fn kill_group(pgid: u32, sig: i32) -> Result<()> {
    let rc = unsafe { libc::killpg(pgid as i32, sig) };
    if rc != 0 {
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() != Some(libc::ESRCH) {
            anyhow::bail!("killpg({pgid}, {sig}): {err}");
        }
    }
    Ok(())
}

/// True while ANY process still lives in process group `pgid` —
/// kill(-pgid, 0) returns ESRCH only once the whole group is gone, so a
/// leader that exits while its children still flush keeps this true.
/// EPERM also means the group exists.
pub fn group_alive(pgid: u32) -> bool {
    let rc = unsafe { libc::kill(-(pgid as i32), 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Grace window between SIGTERM and SIGKILL on a supervised child —
/// shared by /terminate's app stop and the collector stop/restart path.
pub const SIGTERM_GRACE: Duration = Duration::from_millis(1500);

/// Clear the child's pid and log when it exits on its own (crash detection —
/// the reaper records every waitpid status). Clearing `pid_holder` keeps a
/// recycled pid from ever receiving our signals; `expected` marks deliberate
/// stops so they log at info, not warn.
pub fn watch_exit(
    reaper: &'static Reaper,
    pid: u32,
    name: &'static str,
    pid_holder: std::sync::Arc<Mutex<Option<u32>>>,
    expected: std::sync::Arc<AtomicBool>,
) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(250)).await;
            if let Some(status) = reaper.take(pid) {
                reaper.unwatch(pid);
                if let Ok(mut g) = pid_holder.lock() {
                    // Only clear OUR pid — a stop→start race may already
                    // have parked the replacement child here; clearing
                    // unconditionally would orphan it from signal paths.
                    if *g == Some(pid) {
                        *g = None;
                    }
                }
                if expected.load(Ordering::Relaxed) {
                    info!(pid, status, name, "child exited");
                } else {
                    warn!(pid, status, name, "child exited on its own");
                }
                return;
            }
        }
    });
}

/// Maps pid → raw wait status for every reaped child.
/// The reaper thread runs for the life of the process; it is never joined.
pub struct Reaper {
    statuses: Mutex<HashMap<u32, i32>>,
    /// Pids whose exit status MUST be recorded even when the bounded map
    /// is full — the app and collector are watched, and dropping their
    /// status would leave stale ids in signal paths forever.
    watched: Mutex<HashSet<u32>>,
}

impl Reaper {
    /// Start the waitpid(-1, WNOHANG) loop on a dedicated thread.
    pub fn start() -> &'static Reaper {
        // &'static mut → &'static (Copy) so the closure and the caller share it.
        let r: &'static Reaper = Box::leak(Box::new(Reaper {
            statuses: Mutex::new(HashMap::new()),
            watched: Mutex::new(HashSet::new()),
        }));
        thread::spawn(move || {
            loop {
                let mut status: i32 = 0;
                let pid = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
                if pid > 0 {
                    debug!(pid, status, "reaped child");
                    // Lock order: watched before statuses (both here and
                    // in watch/unwatch callers) to avoid deadlock.
                    let watched = r.watched.lock().ok().map(|w| w.contains(&(pid as u32)));
                    if let Ok(mut m) = r.statuses.lock()
                        && (watched == Some(true) || m.len() < 1024)
                    {
                        // Bound the map — adopted orphans would grow it
                        // forever. Watched pids always get a slot.
                        m.insert(pid as u32, status);
                    }
                } else if pid == 0 {
                    thread::sleep(Duration::from_millis(25));
                } else {
                    let err = std::io::Error::last_os_error();
                    if err.raw_os_error() == Some(libc::ECHILD) {
                        thread::sleep(Duration::from_millis(25));
                    } else {
                        warn!(?err, "waitpid failed");
                        thread::sleep(Duration::from_millis(250));
                    }
                }
            }
        });
        r
    }

    /// A reaper without the waitpid thread, for tests: a live reaper
    /// would reap every child of the test binary, including children
    /// that other tests wait on themselves.
    #[cfg(test)]
    pub fn idle() -> &'static Reaper {
        Box::leak(Box::new(Reaper {
            statuses: Mutex::new(HashMap::new()),
            watched: Mutex::new(HashSet::new()),
        }))
    }

    /// Spawn a child AND register it as watched under one lock hold —
    /// the reaper thread blocks on `watched` while checking a reaped
    /// pid, so holding the lock across spawn+insert closes the window
    /// where a fast-exiting child's status would be dropped before its
    /// watch was registered.
    pub fn spawn_watched(&self, spec: &ChildSpec) -> Result<u32> {
        let mut w = self
            .watched
            .lock()
            .map_err(|_| anyhow::anyhow!("watch lock"))?;
        let pid = spawn(spec)?;
        w.insert(pid);
        Ok(pid)
    }

    /// Stop watching `pid` (call after taking its exit status).
    pub fn unwatch(&self, pid: u32) {
        if let Ok(mut w) = self.watched.lock() {
            w.remove(&pid);
        }
    }

    /// Take the exit status of `pid` if it has been reaped.
    pub fn take(&self, pid: u32) -> Option<i32> {
        self.statuses.lock().ok()?.remove(&pid)
    }
}

/// SIGTERM/SIGINT/SIGQUIT to PID 1: forward to the app's process group, give
/// it a grace window, escalate to SIGKILL, then exit. Build-time and runtime
/// semantics don't apply here — this is the container stop path.
/// `app_pgid` and `extra` are resolved at signal time so stale ids can
/// never be signalled after the processes they named have exited.
pub async fn forward_container_signal<G, F>(app_pgid: G, extra: F) -> !
where
    G: Fn() -> Option<u32> + Send,
    F: Fn() -> Vec<u32> + Send,
{
    use tokio::signal::unix::{SignalKind, signal};
    let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
    let mut int = signal(SignalKind::interrupt()).expect("SIGINT handler");
    let mut quit = signal(SignalKind::quit()).expect("SIGQUIT handler");
    let sig = tokio::select! {
        _ = term.recv() => libc::SIGTERM,
        _ = int.recv() => libc::SIGINT,
        _ = quit.recv() => libc::SIGQUIT,
    };
    info!(sig, "container stop signal received, forwarding");
    if let Some(pgid) = app_pgid() {
        let _ = kill_group(pgid, sig);
    }
    // `extra` pids are process-group leaders (every supervised child
    // gets setpgid) — kill_group reaches their children too, consistent
    // with Collector::stop; a leader-only kill would orphan them until
    // VM teardown.
    for pgid in extra() {
        let _ = kill_group(pgid, sig);
    }
    tokio::time::sleep(Duration::from_secs(5)).await;
    if let Some(pgid) = app_pgid() {
        let _ = kill_group(pgid, libc::SIGKILL);
    }
    for pgid in extra() {
        let _ = kill_group(pgid, libc::SIGKILL);
    }
    std::process::exit(128 + sig);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression for the musl-container EPERM: the privilege drop must run
    /// setgroups → setgid → setuid inside pre_exec while still privileged —
    /// std's uid()/gid() run BEFORE user pre_exec closures, which left
    /// setgroups unprivileged and killed the spawn. Requires root; skips
    /// silently under an unprivileged dev/CI run.
    #[test]
    fn spawn_drops_privileges_as_root() {
        if unsafe { libc::geteuid() } != 0 {
            eprintln!("not root — skipping privilege-drop test");
            return;
        }
        let out = std::env::temp_dir().join(format!("kagero-uid-{}", std::process::id()));
        let args = vec![
            "-c".to_string(),
            format!("id > '{0}'; id -G >> '{0}'", out.display()),
        ];
        let pid = spawn(&ChildSpec {
            program: "/bin/sh",
            args: &args,
            uid: Some(65534),
            gid: Some(65534),
            scrub_aws_env: false,
        })
        .expect("spawn with privilege drop must succeed (EPERM regression)");
        // No reaper runs under `cargo test` — wait here. Retry on EINTR so
        // an interrupted waitpid can't race the file read below.
        let mut status = 0;
        loop {
            let rc = unsafe { libc::waitpid(pid as i32, &mut status, 0) };
            if rc == pid as i32 {
                break;
            }
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() != Some(libc::EINTR) {
                panic!("waitpid({pid}) failed: {err}");
            }
        }
        assert!(
            libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0,
            "child failed to run id: status={status}"
        );
        let reported = std::fs::read_to_string(&out).expect("child wrote id output");
        let _ = std::fs::remove_file(&out);
        assert!(
            reported.contains("uid=65534"),
            "uid not dropped: {reported}"
        );
        assert!(
            reported.contains("gid=65534"),
            "gid not dropped: {reported}"
        );
        // Supplementary groups must contain nothing but the primary gid —
        // `id -G` prints the getgroups() set (empty or "65534" depending on
        // libc); per-token equality also catches leaked non-zero groups that
        // a substring check for ",0(" / "groups=0" would miss.
        let groups_line = reported.lines().nth(1).unwrap_or_default();
        for g in groups_line.split_whitespace() {
            assert_eq!(g, "65534", "supplementary groups leaked: {reported}");
        }
    }
}
