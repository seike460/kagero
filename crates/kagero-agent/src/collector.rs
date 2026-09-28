//! Collector supervision (microvms.md §3, ADR-007): render the config from
//! a template, start or reload the collector process, stop it on /terminate.
//!
//! Template placeholders (`{{NAME}}`):
//!   KAGERO_MICROVM_ID / KAGERO_TENANT_ID / KAGERO_SESSION_ID
//!   KAGERO_IMAGE_NAME / KAGERO_IMAGE_VERSION / KAGERO_SIZE / KAGERO_REGION
//!   KAGERO_OTLP_PORT / KAGERO_BACKEND
//!   KAGERO_ENDPOINT_LGTM / KAGERO_ENDPOINT_CLOUDWATCH
//!   KAGERO_ENDPOINT_CW_METRICS / KAGERO_ENDPOINT_CW_LOGS /
//!   KAGERO_ENDPOINT_CW_TRACES (per-signal AWS OTLP overrides; unset values
//!   derive from the region)
//!   KAGERO_SECRET (raw SecretString) / KAGERO_SECRET:key (one key of a JSON secret)
//!   KAGERO_RESOURCE_ATTRS — YAML lines, all identity attributes (logs/traces)
//!   KAGERO_METRIC_ATTRS — YAML lines, label-allowed attributes only (ADR-008)

use anyhow::{Context, Result};
use std::sync::Mutex;
use tracing::{info, warn};

use crate::config::{Backend, Config};
use crate::identity::Identity;
use crate::process::{self, ChildSpec, Reaper};

/// Metrics keep every attribute the registry does not forbid — the list
/// is generated from semconv/registry/kagero.yaml so the filter can never
/// drift from the schema (ADR-008).
fn yaml_attrs(attrs: &[(String, String)], allowed_only: bool) -> String {
    attrs
        .iter()
        .filter(|(k, _)| {
            !allowed_only || !crate::semconv_gen::METRIC_LABEL_FORBIDDEN.contains(&k.as_str())
        })
        .map(|(k, v)| {
            format!(
                "    - key: {k}\n      value: {}\n      action: upsert",
                yaml_quote(v)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Double-quote a scalar for YAML, escaping what could break the template.
fn yaml_quote(v: &str) -> String {
    let mut out = String::with_capacity(v.len() + 2);
    out.push('"');
    for c in v.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

pub struct RenderContext<'a> {
    pub identity: &'a Identity,
    pub secret: Option<&'a str>,
}

/// Single left-to-right pass over the PRISTINE template. Marks are only
/// ever matched against template text — substituted values (identity ids
/// from runHookPayload, attribute lists, secret material) are never
/// re-scanned, so nothing an untrusted value contains can trigger a
/// second expansion. Unknown `{{KAGERO_*` marks stay verbatim and trip
/// the fail-closed leftover check.
pub fn render_template(template: &str, cfg: &Config, ctx: &RenderContext) -> String {
    let id = ctx.identity;
    let attrs = crate::identity::identity_attributes(
        id,
        &cfg.image_name,
        &cfg.image_version,
        &cfg.microvm_size,
        &cfg.region,
    );
    let secret_doc: Option<serde_json::Value> = ctx
        .secret
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());

    let scalar = |name: &str| -> Option<String> {
        Some(match name {
            "KAGERO_MICROVM_ID" => id.microvm_id.clone(),
            "KAGERO_TENANT_ID" => id.tenant_id.clone().unwrap_or_default(),
            "KAGERO_SESSION_ID" => id.session_id.clone().unwrap_or_default(),
            "KAGERO_IMAGE_NAME" => cfg.image_name.clone(),
            "KAGERO_IMAGE_VERSION" => cfg.image_version.clone(),
            "KAGERO_SIZE" => cfg.microvm_size.clone(),
            "KAGERO_REGION" => cfg.region.clone(),
            "KAGERO_OTLP_PORT" => cfg.otlp_port.to_string(),
            // Endpoints are required-when-referenced: an unset endpoint
            // must NOT expand to `""` (the collector would then export
            // into the void with no placeholder left to detect). Leave
            // the mark so the leftover check fails closed.
            "KAGERO_ENDPOINT_LGTM" => match &cfg.otlp_endpoint_lgtm {
                Some(e) if !e.is_empty() => e.clone(),
                _ => return None,
            },
            "KAGERO_ENDPOINT_CLOUDWATCH" => match &cfg.otlp_endpoint_cloudwatch {
                Some(e) if !e.is_empty() => e.clone(),
                _ => return None,
            },
            // AWS OTLP endpoints are per-signal, each with its own SigV4
            // service (monitoring/logs/xray). Resolution order: per-signal
            // override → legacy single-endpoint env → region-derived AWS
            // default. An empty result leaves the mark → fail closed.
            "KAGERO_ENDPOINT_CW_METRICS" => {
                cw_signal_endpoint(cfg, &cfg.otlp_endpoint_cw_metrics, "monitoring")?
            }
            "KAGERO_ENDPOINT_CW_LOGS" => {
                cw_signal_endpoint(cfg, &cfg.otlp_endpoint_cw_logs, "logs")?
            }
            "KAGERO_ENDPOINT_CW_TRACES" => {
                cw_signal_endpoint(cfg, &cfg.otlp_endpoint_cw_traces, "xray")?
            }
            "KAGERO_BACKEND" => match cfg.backend {
                Backend::Lgtm => "lgtm",
                Backend::Cloudwatch => "cloudwatch",
                Backend::Both => "both",
            }
            .to_string(),
            _ => return None,
        })
    };

    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{KAGERO_") {
        out.push_str(&rest[..start]);
        let mark_end = start + 2 + rest[start + 2..].find("}}").map(|e| e + 2).unwrap_or(0);
        if mark_end == start + 2 {
            // No closing "}}" — keep the tail verbatim.
            out.push_str(&rest[start..]);
            rest = "";
            break;
        }
        let mark = &rest[start..mark_end];
        let name = &rest[start + 2..mark_end - 2];
        let value: Option<String> = match name {
            "KAGERO_RESOURCE_ATTRS" => Some(yaml_attrs(&attrs, false)),
            "KAGERO_METRIC_ATTRS" => Some(yaml_attrs(&attrs, true)),
            // The bare form embeds the raw secret document — it goes
            // through the same value-safety check as keyed expansion.
            // A JSON doc with quotes/braces fails closed here: verbatim
            // embedding into YAML/River/env would corrupt the file, so
            // templates that need the document must use keyed expansion
            // or accept the mark being left (fail-closed).
            // No secret at all: consume the mark — same parity as the
            // keyed form (a missing secret is enforced separately by
            // configure_and_ensure_running; /ready renders without one).
            "KAGERO_SECRET" => match ctx.secret {
                Some(s) => Some(s.to_string()).filter(|v| secret_value_safe(v)),
                None => Some(String::new()),
            },
            _ if name.starts_with("KAGERO_SECRET:") => match &secret_doc {
                Some(doc) => doc
                    .get(&name["KAGERO_SECRET:".len()..])
                    .map(|v| {
                        v.as_str()
                            .map(String::from)
                            .unwrap_or_else(|| v.to_string())
                    })
                    .filter(|v| secret_value_safe(v)),
                // Unsafe secret values (quotes, backslashes, newlines,
                // or a nested "{{" mark) would corrupt the rendered YAML/
                // River/env or inject template syntax — leaving the mark
                // unresolved fails the leftover-placeholder check below.
                // No secret at all: consume the mark — /ready renders with
                // secret=None legitimately, and configure_and_ensure_running
                // fails closed separately when a secret was expected.
                None if ctx.secret.is_none() => Some(String::new()),
                // Secret present but unparseable — like a missing KEY —
                // leaves the mark so the leftover check fails closed.
                None => None,
            },
            _ => scalar(name),
        };
        match value {
            Some(v) => out.push_str(&v),
            None => out.push_str(mark),
        }
        rest = &rest[mark_end..];
    }
    out.push_str(rest);
    out
}

/// Per-signal CloudWatch OTLP endpoint: explicit override, else the legacy
/// single-endpoint env, else the AWS default for this signal's service
/// name and region (logs./monitoring./xray.<region>.amazonaws.com).
fn cw_signal_endpoint(cfg: &Config, ov: &Option<String>, service: &str) -> Option<String> {
    if let Some(e) = ov.as_ref().filter(|e| !e.is_empty()) {
        return Some(e.clone());
    }
    if let Some(e) = cfg
        .otlp_endpoint_cloudwatch
        .as_ref()
        .filter(|e| !e.is_empty())
    {
        return Some(e.clone());
    }
    if cfg.region.is_empty() {
        return None;
    }
    Some(format!("https://{service}.{}.amazonaws.com", cfg.region))
}

/// Secrets are interpolated verbatim into YAML/River/env config — a value
/// containing quotes, escapes, newlines, or a nested placeholder mark
/// could corrupt the file or smuggle collector config. Keep to printable
/// ASCII without `"`, `\`, backtick, `$`, or `{{` (collector/README.md).
fn secret_value_safe(v: &str) -> bool {
    !v.is_empty()
        && v.bytes().all(|b| (0x20..=0x7e).contains(&b))
        && !v.contains(['"', '\\', '`', '$'])
        && !v.contains("{{")
}

pub struct Collector {
    pid: std::sync::Arc<Mutex<Option<u32>>>,
    /// The current child's deliberate-stop flag, set before a stop so its
    /// exit watcher doesn't cry crash. Every spawn gets a fresh flag: a
    /// restart must not clear the flag the old child's watcher still reads.
    expected_exit: Mutex<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    reaper: &'static Reaper,
    /// Canonical config path the rendered file was last written to. The
    /// collector argv must use THIS, never cfg.collector_config_out: the
    /// configured path may traverse a symlink the app can swap after the
    /// write, and re-resolving at spawn could land on the attacker's file.
    resolved_out: Mutex<Option<std::path::PathBuf>>,
}

impl Collector {
    pub fn new(reaper: &'static Reaper) -> Self {
        Self {
            pid: std::sync::Arc::new(Mutex::new(None)),
            expected_exit: Mutex::default(),
            reaper,
            resolved_out: Mutex::new(None),
        }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Option<u32>>> {
        self.pid
            .lock()
            .map_err(|_| anyhow::anyhow!("collector lock poisoned"))
    }

    pub fn is_running(&self) -> bool {
        self.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    /// Process-group id of the running collector, if any.
    pub fn pgid(&self) -> Option<u32> {
        *self.lock().ok()?
    }

    /// Write the rendered config (0600 — it may embed a fetched secret) and
    /// start or reload the collector. `budget` is the caller's remaining
    /// hook budget — a wedged collector must not hang /run past Lambda's
    /// deadline (§5-2).
    pub async fn configure_and_ensure_running(
        &self,
        cfg: &Config,
        ctx: &RenderContext<'_>,
        budget: std::time::Duration,
    ) -> Result<()> {
        // Mirror build_check: supervisor-only images carry no collector
        // process — nothing to configure.
        if cfg.collector_bin.is_none() {
            return Ok(());
        }
        let template =
            std::fs::read_to_string(&cfg.collector_config_template).with_context(|| {
                format!("read collector template {}", cfg.collector_config_template)
            })?;
        // Fail closed: a template that references secret material but has
        // none available would start the collector on empty credentials —
        // silent permanent auth failures. /ready (build_check) is
        // unaffected: it never reaches this function.
        if ctx.secret.is_none() && template.contains("{{KAGERO_SECRET") {
            anyhow::bail!("collector template needs secret material but none was fetched");
        }
        let rendered = render_template(&template, cfg, ctx);
        // A leftover kagero placeholder means a value we were supposed to
        // supply is missing (e.g. the secret fetch failed) — writing that
        // would start the collector on a broken config.
        if rendered.contains("{{KAGERO_") {
            anyhow::bail!("collector template still has unresolved KAGERO placeholders");
        }
        let resolved = write_config(&cfg.collector_config_out, &rendered, cfg.app_uid)?;
        let path_changed = {
            let mut g = self
                .resolved_out
                .lock()
                .map_err(|_| anyhow::anyhow!("collector lock poisoned"))?;
            let changed = g.as_ref() != Some(&resolved);
            *g = Some(resolved);
            changed
        };

        if self.is_running() {
            // Cap at 5s AND at the caller's remaining hook budget —
            // a fixed cap alone could overrun Lambda's deadline.
            let cap = budget.min(std::time::Duration::from_secs(5));
            if path_changed {
                // The running collector re-reads its ORIGINAL argv path
                // on reload — a changed resolution means the new config
                // lives elsewhere, and an HTTP reload would happily
                // reload the stale file. Only a restart picks it up.
                let started = std::time::Instant::now();
                self.stop(cap).await?;
                return self.start(cfg, cap.saturating_sub(started.elapsed())).await;
            }
            return self.reload(cfg, cap).await;
        }
        self.start(cfg, budget).await
    }

    pub async fn start(&self, cfg: &Config, budget: std::time::Duration) -> Result<()> {
        // Callers gate on collector_bin.is_some() — reaching this without a
        // binary is a bug, so fail loudly rather than silently skipping.
        let Some(bin) = &cfg.collector_bin else {
            anyhow::bail!("collector start requested but KAGERO_COLLECTOR_BIN is unset");
        };
        // The argv contract is config, not code — Alloy, otelcol and
        // rotel take different shapes (see KAGERO_COLLECTOR_ARGS docs).
        // The config path is the canonical path write_config produced —
        // the raw configured path may traverse an app-swappable symlink.
        let config_path = self
            .resolved_out
            .lock()
            .map_err(|_| anyhow::anyhow!("collector lock poisoned"))?
            .clone()
            .context("collector start before first config write")?
            .to_string_lossy()
            .into_owned();
        let mut args: Vec<String> = cfg.collector_args.clone();
        if !args.is_empty() && !args.iter().any(|a| a.contains("{config}")) {
            args.push(config_path.clone());
        }
        for a in &mut args {
            *a = a.replace("{config}", &config_path);
        }
        let pid = self.reaper.spawn_watched(&ChildSpec {
            program: bin,
            args: &args,
            uid: None,
            gid: None,
            // The collector needs credential env vars for SigV4 CloudWatch
            // export — it is trusted code, unlike the app.
            scrub_aws_env: false,
        })?;
        let expected = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        *self
            .expected_exit
            .lock()
            .map_err(|_| anyhow::anyhow!("collector lock poisoned"))? = expected.clone();
        *self.lock()? = Some(pid);
        info!(pid, "collector started");
        process::watch_exit(self.reaper, pid, "collector", self.pid.clone(), expected);
        // Wait for the OTLP receiver to actually listen — a just-spawned
        // collector takes a few hundred ms, and telemetry posted in that
        // gap hits connection-refused and is dropped forever.
        self.wait_ready(cfg, budget).await;
        Ok(())
    }

    /// Poll the collector's loopback OTLP port until it accepts a TCP
    /// connection, the budget runs out, or the process dies — whichever
    /// comes first. Readiness failure is NOT fatal (fail-open, ADR-004);
    /// it only means the next few telemetry posts may drop.
    async fn wait_ready(&self, cfg: &Config, budget: std::time::Duration) {
        let deadline = std::time::Instant::now() + budget.min(std::time::Duration::from_secs(3));
        while std::time::Instant::now() < deadline {
            if !self.is_running() {
                return; // died during startup — retrying is pointless
            }
            if tokio::net::TcpStream::connect(("127.0.0.1", cfg.otlp_port))
                .await
                .is_ok()
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }

    /// Reload via the configured endpoint; if reload fails or isn't
    /// configured, restart the process so the new config takes effect.
    /// `budget` bounds the HTTP call so a wedged collector can't hang /resume.
    pub async fn reload(&self, cfg: &Config, budget: std::time::Duration) -> Result<()> {
        let started = std::time::Instant::now();
        if let Some(url) = &cfg.collector_reload_url {
            let resp = crate::local_http_client()
                .post(url)
                .timeout(budget)
                .send()
                .await;
            match resp {
                Ok(r) if r.status().is_success() => return Ok(()),
                Ok(r) => warn!(status = %r.status(), "collector reload endpoint failed"),
                Err(e) => warn!(?e, "collector reload endpoint unreachable"),
            }
        }
        // The HTTP attempt already consumed part of the budget — the
        // stop grace must only see what remains, or the restart path
        // overruns the hook deadline.
        self.stop(budget.saturating_sub(started.elapsed())).await?;
        self.start(cfg, budget.saturating_sub(started.elapsed()))
            .await
    }

    /// SIGTERM, wait briefly (capped by the caller's remaining hook
    /// budget), SIGKILL. Used at /terminate and when the container stops.
    pub async fn stop(&self, budget: std::time::Duration) -> Result<()> {
        self.expected_exit
            .lock()
            .map_err(|_| anyhow::anyhow!("collector lock poisoned"))?
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let Some(pid) = self.lock()?.take() else {
            return Ok(());
        };
        let _ =
            process::kill_group(pid, libc::SIGTERM).or_else(|_| process::kill(pid, libc::SIGTERM));
        // Poll the whole process GROUP for exit — a leader that exits
        // while its children still flush must not cut the grace short.
        let until = std::time::Instant::now() + process::SIGTERM_GRACE.min(budget);
        while process::group_alive(pid) && std::time::Instant::now() < until {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        // Escalate on the whole group — collector children would survive a
        // leader-only SIGKILL.
        let _ =
            process::kill_group(pid, libc::SIGKILL).or_else(|_| process::kill(pid, libc::SIGKILL));
        Ok(())
    }
}

/// Write `contents` atomically and return the canonical path the file
/// actually landed at — the caller must hand THIS path to the collector.
fn write_config(path: &str, contents: &str, app_uid: Option<u32>) -> Result<std::path::PathBuf> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    use std::path::Path;
    let p = Path::new(path);
    // The collector argv path is a String — a non-UTF-8 component would
    // be lossy-mangled into a DIFFERENT path, and the app could plant
    // the mangled name to feed its own config to the collector.
    let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
        anyhow::bail!("collector config path {} is not valid UTF-8", path);
    };
    let dir = resolve_output_dir(p.parent().unwrap_or_else(|| Path::new(".")), app_uid)?;
    // Write into a fresh 0600 sibling, then rename over the target: the
    // untrusted app may have created `path` already and hold an open fd
    // (shipped examples put the output in world-writable /tmp) — writing
    // into it would leak the rendered secret through that fd, and a
    // pre-placed symlink would make the agent overwrite an arbitrary
    // file as root. rename(2) replaces the directory entry atomically:
    // the app's fd keeps its own unlinked inode and the symlink itself
    // is replaced, never followed. The dir guard above keeps the app
    // from swapping our tmp file before the rename.
    let target = dir.join(name);
    // The resolved path must be UTF-8 too — an allowed link could point
    // at a dir whose name mangles differently. Check BEFORE creating
    // the tmp file so a bail leaves nothing behind.
    if target.to_str().is_none() {
        anyhow::bail!(
            "collector config resolved path {} is not valid UTF-8",
            target.display()
        );
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    for attempt in 0u8..8 {
        let tmp = dir.join(format!(".{name}.kagero-{stamp}-{attempt}.tmp"));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)
        {
            Ok(mut f) => {
                let r = f
                    .write_all(contents.as_bytes())
                    .and_then(|_| f.sync_all())
                    .and_then(|_| std::fs::rename(&tmp, &target));
                if let Err(e) = r {
                    let _ = std::fs::remove_file(&tmp);
                    return Err(e.into());
                }
                return Ok(target);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    anyhow::bail!("collector config: no free tmp name in {}", dir.display())
}

/// Resolve `dir`, create any missing tail inside the vetted result, and
/// require every component of the resolved path to be out of the
/// untrusted app's reach: no symlink, no component owned by the app uid
/// (it could swap our tmp file before the rename), and no
/// group/other-write without the sticky bit (same swap, by any member —
/// we cannot enumerate the app's groups). Sticky + writable (e.g. /tmp)
/// is safe: the app can create files but cannot unlink or rename
/// foreign ones.
fn resolve_output_dir(dir: &std::path::Path, app_uid: Option<u32>) -> Result<std::path::PathBuf> {
    use std::os::unix::fs::MetadataExt;
    use std::path::{Component, PathBuf};
    // Pass 1 — lexical walk of the EXISTING prefix. Directories must
    // pass the same component checks as resolved ones. A symlink is
    // allowed only when the app does not own it — an app-owned link can
    // be re-pointed at any time and would aim root's mkdir+write (the
    // secret-containing config) at a location the app chose. Root-owned
    // system links (e.g. /var → private/var) are fine: the app cannot
    // swap them, and their targets are vetted in pass 2.
    let mut prefix = PathBuf::new();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut missing = false;
    for comp in dir.components() {
        if missing {
            match comp {
                Component::Normal(n) => tail.push(n.to_os_string()),
                // ".." below a component we are about to create would
                // silently relocate the write target — refuse.
                Component::ParentDir => anyhow::bail!(
                    "collector config dir {} has '..' below a missing component",
                    dir.display()
                ),
                _ => {}
            }
            continue;
        }
        prefix.push(comp.as_os_str());
        match std::fs::symlink_metadata(&prefix) {
            Ok(md) => {
                if md.file_type().is_symlink() {
                    if app_uid == Some(md.uid()) {
                        anyhow::bail!(
                            "collector config dir {} traverses an app-owned symlink",
                            prefix.display()
                        );
                    }
                } else {
                    check_dir_component(&prefix, &md, app_uid)?;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                missing = true;
                prefix.pop();
                if let Component::Normal(n) = comp {
                    tail.push(n.to_os_string());
                }
            }
            Err(e) => return Err(e).context(format!("collector config dir {}", prefix.display())),
        }
    }
    // Pass 2 — canonicalize the vetted existing prefix (collapses the
    // allowed links) and re-vet every resolved component. The returned
    // real path is what the tmp file and rename actually use, so a link
    // swapped afterwards cannot redirect them. A fully-missing relative
    // dir leaves an empty prefix — resolve from the cwd.
    if prefix.as_os_str().is_empty() {
        prefix = PathBuf::from(".");
    }
    let real = std::fs::canonicalize(&prefix)
        .map_err(|e| anyhow::anyhow!("collector config dir {}: {e}", prefix.display()))?;
    let mut cur = PathBuf::from("/");
    for comp in real.components() {
        match comp {
            Component::Normal(n) => cur.push(n),
            Component::ParentDir => cur.push(".."),
            _ => continue,
        }
        let md = std::fs::symlink_metadata(&cur)?;
        check_dir_component(&cur, &md, app_uid)?;
    }
    // Pass 3 — materialize the missing tail inside the vetted dir, one
    // level at a time, post-checked: an app-planted symlink or app-owned
    // dir bails instead of being followed.
    let mut out = real;
    for name in tail {
        out.push(&name);
        match std::fs::create_dir(&out) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
        let md = std::fs::symlink_metadata(&out)?;
        check_dir_component(&out, &md, app_uid)?;
    }
    Ok(out)
}

/// One component must be a real directory the app cannot redirect.
fn check_dir_component(
    path: &std::path::Path,
    md: &std::fs::Metadata,
    app_uid: Option<u32>,
) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    if md.file_type().is_symlink() {
        anyhow::bail!(
            "collector config dir {} traverses a symlink",
            path.display()
        );
    }
    // A regular file (or fifo/socket) must not pass as a "directory":
    // the app could plant one where the parent goes, let the checks
    // pass, then swap it for a symlink and redirect the tmp file, the
    // rename target, and the path the collector later reads.
    if !md.is_dir() {
        anyhow::bail!("collector config dir {} is not a directory", path.display());
    }
    if app_uid == Some(md.uid()) {
        anyhow::bail!(
            "collector config dir {} is owned by the app uid",
            path.display()
        );
    }
    if md.mode() & 0o022 != 0 && md.mode() & 0o1000 == 0 {
        anyhow::bail!(
            "collector config dir {} is group/other-writable without the sticky bit",
            path.display()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config;
    use crate::identity::identity_attributes;

    fn ctx<'a>(id: &'a Identity) -> RenderContext<'a> {
        RenderContext {
            identity: id,
            secret: Some(r#"{"username":"u1","password":"p1","basic_b64":"dTE6cDE="}"#),
        }
    }

    #[test]
    fn write_config_keeps_secret_from_a_preopened_fd() {
        // The untrusted app may pre-create the target world-readable and
        // hold an fd — writing into it would leak the rendered secret.
        let dir = std::env::temp_dir().join(format!("kagero-wcfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("collector.yaml");
        std::fs::write(&target, "attacker-content").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644)).unwrap();
        let mut held = std::fs::File::open(&target).unwrap();

        write_config(target.to_str().unwrap(), "secret-rendered", None).unwrap();

        // The pre-opened fd still reads the attacker's own unlinked inode.
        use std::io::Read;
        let mut via_held = String::new();
        held.read_to_string(&mut via_held).unwrap();
        assert_eq!(via_held, "attacker-content");
        // The path now carries the rendered content under mode 0600.
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "secret-rendered");
        assert_eq!(
            std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o600
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_config_replaces_a_preplaced_symlink() {
        let dir = std::env::temp_dir().join(format!("kagero-wsym-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("collector.yaml");
        let victim = dir.join("victim.txt");
        std::fs::write(&victim, "victim").unwrap();
        std::os::unix::fs::symlink(&victim, &target).unwrap();

        write_config(target.to_str().unwrap(), "rendered", None).unwrap();

        // The symlink itself was replaced — the victim is untouched.
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "victim");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "rendered");
        assert!(!target.symlink_metadata().unwrap().file_type().is_symlink());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_config_writes_through_a_symlinked_parent_dir() {
        // canonicalize pins the real directory, so the rename cannot be
        // redirected by swapping the link afterwards.
        let dir = std::env::temp_dir().join(format!("kagero-wlnk-{}", std::process::id()));
        let real = dir.join("real");
        std::fs::create_dir_all(&real).unwrap();
        let link = dir.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let target = link.join("collector.yaml");
        let written = write_config(target.to_str().unwrap(), "rendered", None).unwrap();
        // The returned path is the canonical one — the collector argv
        // uses it, so a swapped `link` cannot redirect what it reads.
        assert_eq!(
            written,
            std::fs::canonicalize(real.join("collector.yaml")).unwrap()
        );
        assert_eq!(std::fs::read_to_string(&written).unwrap(), "rendered");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_config_refuses_an_app_owned_parent_dir() {
        // Simulating "app owns the dir" without chown: claim the app runs
        // as our own uid — every dir we create is then app-owned.
        let dir = std::env::temp_dir().join(format!("kagero-wown-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let own = unsafe { libc::geteuid() };
        let target = dir.join("collector.yaml");
        let r = write_config(target.to_str().unwrap(), "rendered", Some(own));
        assert!(r.is_err(), "app-owned parent must fail closed");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_config_refuses_a_regular_file_as_the_parent() {
        // The app plants a FILE where the parent dir goes — passing it
        // would let a post-check swap redirect the write.
        let dir = std::env::temp_dir().join(format!("kagero-wfil-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let blocker = dir.join("blocker");
        std::fs::write(&blocker, "not a dir").unwrap();

        let target = blocker.join("collector.yaml");
        let r = write_config(target.to_str().unwrap(), "rendered", None);
        assert!(r.is_err(), "a regular file as parent must fail closed");
        std::fs::remove_dir_all(&dir).ok();
    }

    // Non-UTF-8 filenames need a filesystem that allows them — APFS
    // (dev machines) rejects them; the MicroVM and CI run Linux.
    #[cfg(target_os = "linux")]
    #[test]
    fn write_config_refuses_a_non_utf8_resolved_path() {
        // A legit link can point at a dir whose name is not UTF-8 — the
        // resolved path would reach argv lossy-mangled, i.e. a DIFFERENT
        // file than the one written.
        use std::os::unix::ffi::OsStrExt;
        let dir = std::env::temp_dir().join(format!("kagero-wutf-{}", std::process::id()));
        let weird = dir.join(std::ffi::OsStr::from_bytes(&[0x62, 0xff]));
        std::fs::create_dir_all(&weird).unwrap();
        let link = dir.join("link");
        std::os::unix::fs::symlink(&weird, &link).unwrap();

        let target = link.join("collector.yaml");
        let r = write_config(target.to_str().unwrap(), "rendered", None);
        assert!(r.is_err(), "a non-UTF-8 resolved path must fail closed");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_config_allows_a_sticky_world_writable_parent() {
        // /tmp semantics: o+w + sticky — the app can create files but
        // cannot unlink/rename foreign ones, so tmp+rename stays safe.
        let dir = std::env::temp_dir().join(format!("kagero-wst-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o1777)).unwrap();
        let target = dir.join("collector.yaml");
        write_config(target.to_str().unwrap(), "rendered", None).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "rendered");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn substitutes_scalar_and_secret_placeholders() {
        let id = Identity {
            microvm_id: "mvm-123".into(),
            tenant_id: Some("t-1".into()),
            session_id: None,
        };
        let cfg = config::fixture();
        let tpl = "id: {{KAGERO_MICROVM_ID}}\nep: {{KAGERO_ENDPOINT_LGTM}}\n\
                   pw: {{KAGERO_SECRET:password}}\nbackend: {{KAGERO_BACKEND}}\n";
        let out = render_template(tpl, &cfg, &ctx(&id));
        assert!(out.contains("id: mvm-123"));
        assert!(out.contains("ep: http://lgtm:4318"));
        assert!(out.contains("pw: p1"));
        assert!(out.contains("backend: lgtm"));
        assert!(!out.contains("{{"));
    }

    /// An untrusted tenant/session id must never reach the secret pass:
    /// the SECRET:key expansion runs on the pristine template only, so a
    /// smuggled "{{KAGERO_SECRET:...}}" stays literal (and would trip the
    /// fail-closed leftover check in configure_and_ensure_running).
    #[test]
    fn hostile_identity_cannot_expand_secrets() {
        let id = Identity {
            microvm_id: "mvm-9".into(),
            tenant_id: Some("evil-{{KAGERO_SECRET:password}}".into()),
            session_id: Some("{{KAGERO_SECRET}}".into()),
        };
        let cfg = config::fixture();
        let tpl = "t: {{KAGERO_TENANT_ID}}\ns: {{KAGERO_SESSION_ID}}\n\
                   pw: {{KAGERO_SECRET:password}}\n";
        let out = render_template(tpl, &cfg, &ctx(&id));
        // The template's own placeholder still resolved…
        assert!(out.contains("pw: p1"));
        // …but the count of the secret value never grows beyond that one
        // honest expansion.
        assert_eq!(out.matches("p1").count(), 1);
        // The smuggled placeholders remain literal — the runtime then
        // refuses to write the file (fail closed).
        assert!(out.contains("{{KAGERO_SECRET:password}}"));
        assert!(out.contains("{{KAGERO_SECRET}}"));
    }

    /// Secret VALUES are data, not code: a secret that itself contains a
    /// placeholder mark (keyed or scalar) must not be re-expanded —
    /// inserted values are never re-scanned (single pristine pass).
    #[test]
    fn secret_values_are_not_recursively_expanded() {
        let id = Identity {
            microvm_id: "m".into(),
            tenant_id: None,
            session_id: None,
        };
        let cfg = config::fixture();
        let hostile = RenderContext {
            identity: &id,
            secret: Some(
                r#"{"username":"{{KAGERO_SECRET:password}}","password":"p{{KAGERO_REGION}}w"}"#,
            ),
        };
        let out = render_template(
            "u: {{KAGERO_SECRET:username}}\npw: {{KAGERO_SECRET:password}}",
            &cfg,
            &hostile,
        );
        // Hostile values fail secret_value_safe() and are never inserted —
        // the marks stay unresolved so configure_and_ensure_running's
        // leftover-placeholder check fails closed instead of writing a
        // config smuggled through secret material.
        assert!(out.contains("u: {{KAGERO_SECRET:username}}"));
        assert!(out.contains("pw: {{KAGERO_SECRET:password}}"));
        assert!(!out.contains("pw: p{{KAGERO_REGION}}w"));
        assert!(!out.contains("pap-northeast-1"));
    }

    /// A secret value that would corrupt the rendered YAML/River/env file
    /// (quote breakout, escape, newline, nested mark) is rejected — the
    /// unresolved mark then trips the fail-closed leftover check.
    #[test]
    fn unsafe_secret_values_fail_closed() {
        let id = Identity {
            microvm_id: "m".into(),
            tenant_id: None,
            session_id: None,
        };
        let cfg = config::fixture();
        for bad in [
            "p\"w",
            "p\\w",
            "p\nw",
            "p$w",
            "p`w",
            "p{{KAGERO_REGION}}w",
            "pあw", // non-ASCII
        ] {
            let ctx = RenderContext {
                identity: &id,
                secret: Some(format!(r#"{{"username":"u1","password":{bad:?}}}"#).leak()),
            };
            let out = render_template("pw: {{KAGERO_SECRET:password}}", &cfg, &ctx);
            assert!(
                out.contains("{{KAGERO_SECRET:password}}"),
                "unsafe secret value {bad:?} must leave the mark unresolved"
            );
        }
    }

    /// Bare `{{KAGERO_SECRET}}` must behave exactly like the keyed form:
    /// no secret → the mark is consumed to "" (so /ready's secret-less
    /// build-check renders), a safe value renders verbatim, and an
    /// unsafe value stays unresolved and fails closed.
    #[test]
    fn bare_secret_matches_keyed_parity() {
        let id = Identity {
            microvm_id: "m".into(),
            tenant_id: None,
            session_id: None,
        };
        let cfg = config::fixture();
        let no_secret = RenderContext {
            identity: &id,
            secret: None,
        };
        let out = render_template(
            "a: [{{KAGERO_SECRET}}]\nb: [{{KAGERO_SECRET:password}}]",
            &cfg,
            &no_secret,
        );
        assert!(out.contains("a: []"));
        assert!(out.contains("b: []"));
        assert!(!out.contains("{{"));

        // A safe non-JSON secret renders verbatim.
        let ok = RenderContext {
            identity: &id,
            secret: Some("plain-token"),
        };
        let out = render_template("a: {{KAGERO_SECRET}}", &cfg, &ok);
        assert!(out.contains("a: plain-token"));

        // A present-but-unsafe value fails closed — mark unresolved.
        for bad in ["p\"w", "p\nw", "p$w"] {
            let hostile = RenderContext {
                identity: &id,
                secret: Some(bad),
            };
            let out = render_template("a: {{KAGERO_SECRET}}", &cfg, &hostile);
            assert!(
                out.contains("{{KAGERO_SECRET}}"),
                "unsafe bare secret {bad:?} must leave the mark unresolved"
            );
        }
    }

    /// Every registry-forbidden attribute must be stripped at ALL THREE
    /// levels — resource, datapoint, AND scope (scope attributes become
    /// otel_scope_* labels on Prometheus-compatible ingestion) — in every
    /// shipped metrics-capable template (drift guard).
    #[test]
    fn templates_strip_every_forbidden_key() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        for rel in [
            "collector/lgtm/collector.yaml.tmpl",
            "collector/cloudwatch/collector.yaml.tmpl",
            "collector/alloy/lgtm.alloy.tmpl",
            // The sim's real-collector fixture shares the same strip
            // contract — drift here would silently weaken the E2E's
            // collector-side proof.
            "packages/sim/fixtures/collector.yaml.tmpl",
        ] {
            let tpl = std::fs::read_to_string(root.join(rel))
                .unwrap_or_else(|e| panic!("read {rel}: {e}"));
            for key in crate::semconv_gen::METRIC_LABEL_FORBIDDEN {
                let occurrences = tpl.matches(key).count();
                assert!(
                    occurrences >= 3,
                    "{rel}: forbidden key {key} must appear in resource-level, \
                     datapoint-level, AND scope-level strip lists"
                );
            }
        }
    }

    /// Rotel applies ROTEL_OTEL_RESOURCE_ATTRIBUTES to ALL signals —
    /// there is no strip processor, so a forbidden key in the shared
    /// attribute list would land on metric labels unnoticed (ADR-008).
    #[test]
    fn rotel_templates_never_carry_forbidden_ids() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        for rel in [
            "collector/rotel/lgtm.env.tmpl",
            "collector/rotel/cloudwatch.env.tmpl",
        ] {
            let tpl = std::fs::read_to_string(root.join(rel))
                .unwrap_or_else(|e| panic!("read {rel}: {e}"));
            for key in crate::semconv_gen::METRIC_LABEL_FORBIDDEN {
                assert!(
                    !tpl.contains(key),
                    "{rel}: forbidden attribute {key} must not appear — \
                     Rotel has no per-signal resource scoping"
                );
            }
        }
    }

    /// The Alloy template hand-lists identity attributes — it must set
    /// every key that identity_attributes() produces (e.g. service.name,
    /// without which Loki's {service_name="kagero"} selector goes empty).
    #[test]
    fn alloy_stamps_every_identity_attribute() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        let tpl = std::fs::read_to_string(root.join("collector/alloy/lgtm.alloy.tmpl"))
            .expect("read alloy template");
        let id = Identity {
            microvm_id: "m".into(),
            tenant_id: Some("t".into()),
            session_id: Some("s".into()),
        };
        for (key, _) in identity_attributes(&id, "img", "1", "2gb", "us-east-1") {
            let needle = format!("attributes[\\\"{key}\\\"]");
            let occurrences = tpl.matches(&needle).count();
            // trace_statements + log_statements at minimum; allowed keys
            // also appear in the metric_identity block.
            assert!(
                occurrences >= 2,
                "alloy template must set identity attribute {key} in \
                 trace_statements and log_statements ({occurrences} found)"
            );
        }
        // And every allowed identity attribute must also be set on the
        // metric path (or labels silently lose dimensions).
        for (key, _) in identity_attributes(&id, "img", "1", "2gb", "us-east-1") {
            if crate::semconv_gen::METRIC_LABEL_FORBIDDEN.contains(&key.as_str()) {
                continue;
            }
            let needle = format!("set(attributes[\\\"{key}\\\"]");
            assert!(
                tpl.matches(&needle).count() >= 3,
                "alloy template: allowed attribute {key} should also be \
                 stamped on metrics (metric_identity block)"
            );
        }
    }

    /// Render the shipped templates end-to-end — a placeholder typo here
    /// would only surface inside a MicroVM otherwise.
    #[test]
    fn renders_shipped_templates() {
        let id = Identity {
            microvm_id: "mvm-1".into(),
            tenant_id: Some("t".into()),
            session_id: Some("s".into()),
        };
        let cfg = config::fixture();
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        for rel in [
            "collector/lgtm/collector.yaml.tmpl",
            "collector/cloudwatch/collector.yaml.tmpl",
            "collector/alloy/lgtm.alloy.tmpl",
            "collector/rotel/lgtm.env.tmpl",
            "collector/rotel/cloudwatch.env.tmpl",
            "packages/sim/fixtures/collector.yaml.tmpl",
        ] {
            let tpl = std::fs::read_to_string(root.join(rel))
                .unwrap_or_else(|e| panic!("read {rel}: {e}"));
            let out = render_template(&tpl, &cfg, &ctx(&id));
            assert!(
                !out.contains("{{KAGERO_"),
                "{rel} left a placeholder unresolved"
            );
        }
    }

    /// A template referencing an endpoint whose env var is unset must
    /// keep its placeholder — configure_and_ensure_running then fails
    /// closed instead of writing `endpoint: ""` (silent export void).
    #[test]
    fn missing_endpoint_keeps_mark() {
        let id = Identity {
            microvm_id: "m".into(),
            tenant_id: None,
            session_id: None,
        };
        let mut cfg = config::fixture();
        cfg.otlp_endpoint_lgtm = None;
        let out = render_template("ep: {{KAGERO_ENDPOINT_LGTM}}", &cfg, &ctx(&id));
        assert!(out.contains("{{KAGERO_ENDPOINT_LGTM}}"));
        cfg.otlp_endpoint_lgtm = Some("".into());
        let out = render_template("ep: {{KAGERO_ENDPOINT_LGTM}}", &cfg, &ctx(&id));
        assert!(out.contains("{{KAGERO_ENDPOINT_LGTM}}"));
    }

    /// A restart must not clear the flag the OLD child's exit watcher
    /// reads — otherwise every deliberate restart (e.g. /resume without a
    /// reload URL) logs "child exited on its own".
    #[tokio::test]
    async fn restart_keeps_the_old_childs_stop_flag() {
        use std::sync::atomic::Ordering;
        use std::time::Duration;
        let mut cfg = config::fixture();
        cfg.collector_bin = Some("/bin/sh".into());
        cfg.collector_args = vec!["-c".into(), "exec sleep 30".into()];
        let c = Collector::new(crate::process::Reaper::idle());
        *c.resolved_out.lock().unwrap() = Some("/dev/null".into());

        c.start(&cfg, Duration::ZERO).await.unwrap();
        let first_pid = c.pgid().unwrap();
        let first = c.expected_exit.lock().unwrap().clone();
        c.stop(Duration::ZERO).await.unwrap();
        c.start(&cfg, Duration::ZERO).await.unwrap();
        let second_pid = c.pgid().unwrap();
        let second = c.expected_exit.lock().unwrap().clone();
        c.stop(Duration::ZERO).await.unwrap();
        // No reaper thread under test — reap both children here.
        for pid in [first_pid, second_pid] {
            while unsafe { libc::waitpid(pid as i32, std::ptr::null_mut(), 0) } == -1
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR)
            {}
        }

        assert!(
            first.load(Ordering::Relaxed),
            "the first child's exit must still read as deliberate"
        );
        assert!(!std::sync::Arc::ptr_eq(&first, &second));
    }

    #[test]
    fn metric_attrs_exclude_instance_ids() {
        let id = Identity {
            microvm_id: "mvm-1".into(),
            tenant_id: Some("t".into()),
            session_id: Some("s".into()),
        };
        let cfg = config::fixture();
        let tpl = "res: |\n{{KAGERO_RESOURCE_ATTRS}}\nmet: |\n{{KAGERO_METRIC_ATTRS}}\n";
        let out = render_template(tpl, &cfg, &ctx(&id));
        let (res, met) = out.split_once("met: |").unwrap();
        // IDs allowed on the resource (log/trace) side…
        assert!(res.contains("mvm-1"));
        assert!(res.contains("t"));
        // …but never on the metric side (ADR-008).
        assert!(!met.contains("mvm-1"));
        assert!(!met.contains("kagero.tenant.id"));
        assert!(met.contains("kagero.microvm.image.name"));
    }
}
