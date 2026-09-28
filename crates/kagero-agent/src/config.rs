//! Agent configuration, taken entirely from non-secret image environment
//! variables (microvms.md §10). Secrets never come from env (ADR-011).

use anyhow::{Context, Result};
use std::collections::HashMap;
use std::env;
use std::net::IpAddr;
use std::time::Duration;
use tracing::warn;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    Lgtm,
    Cloudwatch,
    Both,
}

/// One hook-port allowlist entry: a CIDR ("10.0.0.0/8", "::1/128") or a
/// bare IP (exact match). Real CIDR semantics — a string prefix would
/// never match "10.0.0.0/8" against "10.0.0.1".
#[derive(Debug, Clone, Copy)]
pub struct PeerRule {
    net: IpAddr,
    prefix: u8,
}

impl PeerRule {
    pub fn parse(s: &str) -> Result<Self> {
        let (addr_s, prefix_s) = match s.split_once('/') {
            Some((a, p)) => (a, p),
            None => (s, ""),
        };
        let net: IpAddr = addr_s
            .parse()
            .with_context(|| format!("invalid peer address in {s:?}"))?;
        let max = if net.is_ipv4() { 32 } else { 128 };
        let prefix: u8 = if prefix_s.is_empty() {
            max
        } else {
            prefix_s
                .parse()
                .with_context(|| format!("invalid prefix length in {s:?}"))?
        };
        if prefix > max {
            anyhow::bail!("prefix /{prefix} exceeds /{max} in {s:?}");
        }
        Ok(Self { net, prefix })
    }

    pub fn contains(&self, ip: &IpAddr) -> bool {
        let host: u128 = match ip {
            IpAddr::V4(a) => u32::from(*a) as u128,
            IpAddr::V6(a) => u128::from(*a),
        };
        let net: u128 = match self.net {
            IpAddr::V4(a) => u32::from(a) as u128,
            IpAddr::V6(a) => u128::from(a),
        };
        // v4/v6 families never match each other (no v4-mapped v6 here —
        // the hook port binds one family anyway).
        if ip.is_ipv4() != self.net.is_ipv4() {
            return false;
        }
        // /0 matches every address of the same family — shifting by the
        // full bit-width would panic (u128 >> 128 is a shift overflow).
        if self.prefix == 0 {
            return true;
        }
        let bits = if self.net.is_ipv4() { 32 } else { 128 };
        let shift = bits - self.prefix;
        (host >> shift) == (net >> shift)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CollectorStart {
    /// Start the collector during build (before the snapshot); reconfigure at /run.
    /// With KAGERO_SECRET_ARN set the build-time start defers to /run —
    /// the config embeds credentials that only exist after the /run fetch.
    Build,
    /// Start the collector for the first time at /run.
    Run,
}

#[derive(Debug, Clone)]
pub struct Config {
    // ports
    pub hook_port: u16,
    pub app_hook_port: u16,
    pub otlp_port: u16,
    pub admin_port: u16,
    /// Accepted peer networks on the hook port (comma-separated CIDR or
    /// bare-IP env). Empty = loopback peers denied (the in-VM app is the
    /// only possible loopback source and must not forge hooks); set this
    /// once PoC-02 confirms Lambda's source addresses.
    pub hook_allowed_peers: Vec<PeerRule>,

    // backends
    pub backend: Backend,
    pub otlp_endpoint_lgtm: Option<String>,
    pub otlp_endpoint_cloudwatch: Option<String>,
    /// CloudWatch per-signal OTLP endpoint overrides (VPC endpoints);
    /// unset values are derived from `region` at render time.
    pub otlp_endpoint_cw_metrics: Option<String>,
    pub otlp_endpoint_cw_logs: Option<String>,
    pub otlp_endpoint_cw_traces: Option<String>,

    // microvm shape / attributes
    pub baseline_gib: f64,
    pub baseline_vcpu: f64,
    pub image_name: String,
    pub image_version: String,
    pub microvm_size: String,
    pub region: String,

    // hook time budgets (per-hook override, else default)
    pub hook_timeout_default: Duration,
    pub hook_timeouts: HashMap<String, Duration>,
    /// Fraction of the budget kagero reserves for its own work after/before
    /// relaying to the app (microvms.md §5-2: ~10%).
    pub reserve_fraction: f64,

    // app process
    pub app_command: Vec<String>,
    pub app_uid: Option<u32>,
    pub app_gid: Option<u32>,

    // tenancy extraction from runHookPayload (JSON Pointers)
    pub tenant_pointer: Option<String>,
    pub session_pointer: Option<String>,

    // collector supervision
    pub collector_bin: Option<String>,
    /// argv after the binary, from `KAGERO_COLLECTOR_ARGS` (JSON array).
    /// The token `{config}` is replaced by `collector_config_out`; when a
    /// non-empty list carries no token the config path is appended last.
    /// An empty list means no argv at all (env-file driven collectors —
    /// point KAGERO_COLLECTOR_BIN at a wrapper that sources the file).
    /// Different collectors need different shapes:
    ///   Alloy:      ["run", "--storage.path=/run/kagero/collector-data", "{config}"]
    ///   otelcol:    ["--config", "{config}"]
    ///   rotel:      []           (env-file driven; config path unused)
    pub collector_args: Vec<String>,
    pub collector_config_template: String,
    pub collector_config_out: String,
    pub collector_start: CollectorStart,
    pub collector_reload_url: Option<String>,

    // aws access for /run secret fetch
    pub secret_arn: Option<String>,
    pub imds_endpoint: String,
    pub secrets_endpoint: Option<String>,

    // usage sampling
    pub sample_interval: Duration,
    /// cgroup v2 paths; /proc fallback when unset.
    pub cgroup_path: Option<String>,
}

/// Every env var follows the same policy: malformed values fail startup
/// loudly (a silent fallback would mask a misconfiguration), absent values
/// use the documented default. A non-Unicode value IS malformed — only
/// NotPresent means "use the default".
fn env_string(key: &str) -> Result<Option<String>> {
    match env::var(key) {
        Ok(v) => Ok(Some(v)),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(env::VarError::NotUnicode(v)) => anyhow::bail!("{key} is not valid Unicode: {v:?}"),
    }
}

/// Where `Config` reads its variables: `env_string` in production, a map
/// in tests (edition 2024 makes `env::set_var` unsafe).
type Lookup<'a> = &'a dyn Fn(&str) -> Result<Option<String>>;

fn env_duration_ms(get: Lookup, key: &str) -> Result<Option<Duration>> {
    get(key)?
        .map(|v| {
            v.parse::<u64>()
                .map(Duration::from_millis)
                .with_context(|| format!("{key} must be a number of milliseconds"))
        })
        .transpose()
}

fn env_u32(get: Lookup, key: &str) -> Result<Option<u32>> {
    get(key)?
        .map(|v| {
            v.parse()
                .with_context(|| format!("{key} must be a uid/gid number"))
        })
        .transpose()
}

fn env_f64(get: Lookup, key: &str, what: &str) -> Result<Option<f64>> {
    get(key)?
        .map(|v| {
            v.parse()
                .with_context(|| format!("{key} must be a number ({what})"))
        })
        .transpose()
}

/// Reject zero or absurdly large durations at startup instead of letting a
/// bad env var panic later (panic = "abort" would kill PID 1).
fn validated_timeout(key: &str, v: Option<Duration>) -> Result<Option<Duration>> {
    if let Some(d) = v
        && (d.is_zero() || d > Duration::from_secs(3600))
    {
        anyhow::bail!("{key} out of range: {d:?}");
    }
    Ok(v)
}

/// Values interpolated into YAML/river/env templates: image metadata is
/// trusted, but keep it inside the same safe charset as runtime ids so a
/// stray quote or shell metachar can never break a rendered config.
fn env_safe(get: Lookup, key: &str, default: &str) -> Result<String> {
    let v = get(key)?.unwrap_or_else(|| default.to_string());
    if !v
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '/' | '+' | '='))
    {
        anyhow::bail!("{key} contains characters unsafe for config templates: {v:?}");
    }
    Ok(v)
}

/// Endpoint values render inside double-quoted YAML/Alloy strings — this
/// predicate rejects characters that would corrupt the rendered file
/// (quote, escape, control, non-ASCII). Looser than `env_safe`:
/// legitimate URL chars such as `?`, `&`, `%`, `@` stay allowed.
fn endpoint_safe(v: &str) -> bool {
    v.chars()
        .all(|c| c.is_ascii() && !c.is_ascii_control() && c != '"' && c != '\\')
}

fn env_endpoint(get: Lookup, key: &str) -> Result<Option<String>> {
    match get(key)? {
        Some(v) if v.is_empty() => Ok(None),
        Some(v) if !endpoint_safe(&v) => {
            anyhow::bail!("{key} contains characters unsafe for config templates: {v:?}")
        }
        v => Ok(v),
    }
}

fn env_u16(get: Lookup, key: &str, default: u16) -> Result<u16> {
    get(key)?
        .map(|v| {
            v.parse::<u16>()
                .with_context(|| format!("{key} must be a port number"))
        })
        .transpose()
        .map(|o| o.unwrap_or(default))
}

impl Config {
    pub fn from_env(app_command: Vec<String>) -> Result<Self> {
        Self::from_lookup(app_command, unsafe { libc::geteuid() }, &env_string)
    }

    fn from_lookup(app_command: Vec<String>, euid: u32, get: Lookup) -> Result<Self> {
        let backend = match get("KAGERO_BACKEND")?.as_deref() {
            None | Some("lgtm") => Backend::Lgtm,
            Some("cloudwatch") => Backend::Cloudwatch,
            Some("both") => Backend::Both,
            Some(v) => {
                anyhow::bail!("unknown KAGERO_BACKEND {v:?} — expected lgtm|cloudwatch|both")
            }
        };
        if matches!(backend, Backend::Both) {
            warn!(
                "KAGERO_BACKEND=both: no shipped collector template performs dual \
                 export — the mounted KAGERO_COLLECTOR_CONFIG_TEMPLATE decides the \
                 actual backends (collector/README.md)"
            );
        }
        let baseline_gib: f64 = env_f64(get, "KAGERO_MICROVM_BASELINE_GIB", "GiB")?.unwrap_or(2.0);
        // Pricing: 2 GiB per vCPU (research §1-2).
        let baseline_vcpu =
            env_f64(get, "KAGERO_MICROVM_BASELINE_VCPU", "vCPUs")?.unwrap_or(baseline_gib / 2.0);

        let mut hook_timeouts = HashMap::new();
        for hook in ["ready", "validate", "run", "suspend", "resume", "terminate"] {
            let key = format!("KAGERO_HOOK_TIMEOUT_MS_{}", hook.to_uppercase());
            if let Some(d) = env_duration_ms(get, &key)? {
                hook_timeouts.insert(hook.to_string(), d);
            }
        }

        let running_as_root = euid == 0;
        let app_uid = env_u32(get, "KAGERO_APP_UID")?;
        let app_gid = env_u32(get, "KAGERO_APP_GID")?;
        // ADR: the app runs with privileges dropped by the agent. Default to
        // "nobody" (65534) when the agent itself is root and nothing was set.
        let (app_uid, app_gid) = if running_as_root && app_uid.is_none() {
            (Some(65534), Some(app_gid.unwrap_or(65534)))
        } else {
            // uid set but gid unset → default gid to uid, never root's group.
            let gid = app_gid.or(app_uid);
            (app_uid, gid)
        };

        Ok(Config {
            hook_port: env_u16(get, "KAGERO_HOOK_PORT", 2018)?,
            app_hook_port: env_u16(get, "KAGERO_APP_HOOK_PORT", 2019)?,
            otlp_port: {
                let p = env_u16(get, "KAGERO_OTLP_PORT", 4318)?;
                // Collector templates also bind gRPC on a fixed 4317 —
                // an HTTP port equal to it would collide at startup.
                if p == 4317 {
                    anyhow::bail!("KAGERO_OTLP_PORT must not be 4317 (reserved for OTLP/gRPC)");
                }
                p
            },
            admin_port: env_u16(get, "KAGERO_ADMIN_PORT", 2020)?,
            hook_allowed_peers: {
                let raw = get("KAGERO_HOOK_ALLOWED_PEERS")?.unwrap_or_default();
                let mut rules = Vec::new();
                for s in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                    // Bail at startup rather than silently block all hooks
                    // on a malformed entry.
                    rules.push(PeerRule::parse(s)?);
                }
                rules
            },

            backend,
            otlp_endpoint_lgtm: env_endpoint(get, "KAGERO_OTLP_ENDPOINT_LGTM")?
                .or(env_endpoint(get, "KAGERO_OTLP_ENDPOINT")?),
            // AWS OTLP endpoints are per-signal: logs.<region>, monitoring.
            // <region>, xray.<region> — and each signs with a different
            // SigV4 service (AWS OTLP endpoints doc). Per-signal envs are
            // overrides for VPC/custom endpoints; unset = region-derived.
            otlp_endpoint_cloudwatch: env_endpoint(get, "KAGERO_OTLP_ENDPOINT_CLOUDWATCH")?,
            otlp_endpoint_cw_metrics: env_endpoint(get, "KAGERO_ENDPOINT_CW_METRICS")?,
            otlp_endpoint_cw_logs: env_endpoint(get, "KAGERO_ENDPOINT_CW_LOGS")?,
            otlp_endpoint_cw_traces: env_endpoint(get, "KAGERO_ENDPOINT_CW_TRACES")?,

            baseline_gib,
            baseline_vcpu,
            image_name: env_safe(get, "KAGERO_MICROVM_IMAGE_NAME", "")?,
            image_version: env_safe(get, "KAGERO_MICROVM_IMAGE_VERSION", "")?,
            microvm_size: env_safe(get, "KAGERO_MICROVM_SIZE", &format!("{}gb", baseline_gib))?,
            region: env_safe(
                get,
                "KAGERO_AWS_REGION",
                &get("AWS_REGION")?.unwrap_or_else(|| "us-east-1".into()),
            )?,

            hook_timeout_default: {
                // The runtime hook budget is bounded the same as per-hook
                // overrides (300s) — a larger default would only mask a
                // misconfiguration.
                let d = validated_timeout(
                    "KAGERO_HOOK_TIMEOUT_MS",
                    env_duration_ms(get, "KAGERO_HOOK_TIMEOUT_MS")?,
                )?;
                if let Some(d) = d
                    && d > Duration::from_secs(300)
                {
                    anyhow::bail!("KAGERO_HOOK_TIMEOUT_MS out of range: {d:?} (max 300s)");
                }
                d.unwrap_or(Duration::from_secs(10))
            },
            hook_timeouts: {
                for (hook, d) in &hook_timeouts {
                    if d.is_zero() || *d > Duration::from_secs(300) {
                        anyhow::bail!("hook timeout for {hook} out of range: {d:?}");
                    }
                }
                hook_timeouts
            },
            reserve_fraction: {
                let f: f64 =
                    env_f64(get, "KAGERO_HOOK_RESERVE_FRACTION", "fraction")?.unwrap_or(0.1);
                // >1 or NaN would panic Duration::mul_f64 under panic=abort.
                if !f.is_finite() || !(0.0..1.0).contains(&f) {
                    anyhow::bail!("KAGERO_HOOK_RESERVE_FRACTION must be in [0,1): got {f}");
                }
                f
            },

            app_command,
            app_uid,
            app_gid,

            tenant_pointer: get("KAGERO_TENANT_JSON_POINTER")?,
            session_pointer: get("KAGERO_SESSION_JSON_POINTER")?,

            collector_bin: get("KAGERO_COLLECTOR_BIN")?,
            collector_args: match get("KAGERO_COLLECTOR_ARGS")? {
                Some(v) => serde_json::from_str::<Vec<String>>(&v)
                    .with_context(|| "KAGERO_COLLECTOR_ARGS must be a JSON array of strings")?,
                None => vec![
                    "run".into(),
                    "--storage.path=/run/kagero/collector-data".into(),
                    "{config}".into(),
                ],
            },
            collector_config_template: get("KAGERO_COLLECTOR_CONFIG_TEMPLATE")?
                .unwrap_or_else(|| "/etc/kagero/collector.tmpl".into()),
            collector_config_out: get("KAGERO_COLLECTOR_CONFIG_OUT")?
                .unwrap_or_else(|| "/run/kagero/collector.yaml".into()),
            collector_start: match get("KAGERO_COLLECTOR_START")?.as_deref() {
                Some("build") => CollectorStart::Build,
                Some("run") | None => CollectorStart::Run,
                Some(v) => {
                    anyhow::bail!("unknown KAGERO_COLLECTOR_START {v:?} — expected build|run")
                }
            },
            collector_reload_url: get("KAGERO_COLLECTOR_RELOAD_URL")?,

            secret_arn: get("KAGERO_SECRET_ARN")?,
            imds_endpoint: get("KAGERO_IMDS_ENDPOINT")?
                .unwrap_or_else(|| "http://169.254.169.254".into()),
            secrets_endpoint: get("KAGERO_SECRETS_ENDPOINT")?,

            sample_interval: {
                // Zero would panic tokio::time::interval under panic=abort.
                match validated_timeout(
                    "KAGERO_SAMPLE_INTERVAL_MS",
                    env_duration_ms(get, "KAGERO_SAMPLE_INTERVAL_MS")?,
                )? {
                    Some(d) => d,
                    None => Duration::from_secs(1),
                }
            },
            cgroup_path: get("KAGERO_CGROUP_PATH")?,
        })
    }

    pub fn hook_timeout(&self, hook: &str) -> Duration {
        self.hook_timeouts
            .get(hook)
            .copied()
            .unwrap_or(self.hook_timeout_default)
    }

    /// Time the app gets for a relayed hook: budget minus the reserved slice.
    pub fn app_budget(&self, hook: &str) -> Duration {
        self.hook_timeout(hook).mul_f64(1.0 - self.reserve_fraction)
    }
}

/// A deterministic Config for unit tests (no env reads).
#[cfg(test)]
pub(crate) fn fixture() -> Config {
    let mut hook_timeouts = HashMap::new();
    hook_timeouts.insert("run".to_string(), Duration::from_millis(5000));
    Config {
        hook_port: 2018,
        app_hook_port: 2019,
        otlp_port: 4318,
        admin_port: 2020,
        hook_allowed_peers: vec![],
        backend: Backend::Lgtm,
        otlp_endpoint_lgtm: Some("http://lgtm:4318".into()),
        otlp_endpoint_cloudwatch: Some("https://cw.example.com".into()),
        otlp_endpoint_cw_metrics: None,
        otlp_endpoint_cw_logs: None,
        otlp_endpoint_cw_traces: None,
        baseline_gib: 2.0,
        baseline_vcpu: 1.0,
        image_name: "img".into(),
        image_version: "1.0".into(),
        microvm_size: "2gb".into(),
        region: "ap-northeast-1".into(),
        hook_timeout_default: Duration::from_secs(10),
        hook_timeouts,
        reserve_fraction: 0.1,
        app_command: vec!["/bin/app".into()],
        app_uid: Some(65534),
        app_gid: Some(65534),
        tenant_pointer: None,
        session_pointer: None,
        collector_bin: None,
        collector_args: vec!["{config}".into()],
        collector_config_template: "/etc/kagero/collector.tmpl".into(),
        collector_config_out: "/run/kagero/collector.yaml".into(),
        collector_start: CollectorStart::Run,
        collector_reload_url: None,
        secret_arn: None,
        imds_endpoint: "http://169.254.169.254".into(),
        secrets_endpoint: None,
        sample_interval: Duration::from_secs(1),
        cgroup_path: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: u32 = 0;
    const USER: u32 = 1000;

    fn from_vars(euid: u32, vars: &[(&str, &str)]) -> Result<Config> {
        let vars: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Config::from_lookup(vec!["/bin/app".into()], euid, &|k| Ok(vars.get(k).cloned()))
    }

    #[test]
    fn unset_vars_take_the_documented_defaults() {
        let cfg = from_vars(USER, &[]).unwrap();
        assert_eq!(
            (
                cfg.hook_port,
                cfg.app_hook_port,
                cfg.otlp_port,
                cfg.admin_port
            ),
            (2018, 2019, 4318, 2020)
        );
        assert_eq!(cfg.backend, Backend::Lgtm);
        assert_eq!((cfg.baseline_gib, cfg.baseline_vcpu), (2.0, 1.0));
        assert_eq!(cfg.microvm_size, "2gb");
        assert_eq!(cfg.region, "us-east-1");
        assert_eq!(cfg.hook_timeout_default, Duration::from_secs(10));
        assert_eq!(cfg.reserve_fraction, 0.1);
        assert_eq!(cfg.collector_start, CollectorStart::Run);
        assert!(cfg.hook_allowed_peers.is_empty());
    }

    #[test]
    fn root_agent_runs_the_app_as_nobody_unless_told_otherwise() {
        let ids = |euid, vars: &[(&str, &str)]| {
            let cfg = from_vars(euid, vars).unwrap();
            (cfg.app_uid, cfg.app_gid)
        };
        assert_eq!(ids(ROOT, &[]), (Some(65534), Some(65534)));
        assert_eq!(
            ids(ROOT, &[("KAGERO_APP_GID", "50")]),
            (Some(65534), Some(50))
        );
        // uid only: gid follows the uid, never root's group.
        assert_eq!(
            ids(ROOT, &[("KAGERO_APP_UID", "1000")]),
            (Some(1000), Some(1000))
        );
        assert_eq!(
            ids(
                ROOT,
                &[("KAGERO_APP_UID", "1000"), ("KAGERO_APP_GID", "50")]
            ),
            (Some(1000), Some(50))
        );
        // A non-root agent cannot drop privileges — nothing is forced.
        assert_eq!(ids(USER, &[]), (None, None));
        assert_eq!(
            ids(USER, &[("KAGERO_APP_UID", "1000")]),
            (Some(1000), Some(1000))
        );
    }

    #[test]
    fn empty_endpoint_counts_as_unset() {
        let cfg = from_vars(
            USER,
            &[
                ("KAGERO_OTLP_ENDPOINT_LGTM", ""),
                ("KAGERO_OTLP_ENDPOINT", "http://lgtm:4318"),
            ],
        )
        .unwrap();
        assert_eq!(cfg.otlp_endpoint_lgtm.as_deref(), Some("http://lgtm:4318"));
    }

    #[test]
    fn malformed_values_fail_startup() {
        for (key, value) in [
            ("KAGERO_BACKEND", "aws"),
            ("KAGERO_HOOK_PORT", "70000"),
            ("KAGERO_OTLP_PORT", "4317"),
            ("KAGERO_APP_UID", "-1"),
            ("KAGERO_HOOK_TIMEOUT_MS", "0"),
            ("KAGERO_HOOK_TIMEOUT_MS", "300001"),
            ("KAGERO_HOOK_TIMEOUT_MS_RUN", "0"),
            ("KAGERO_HOOK_TIMEOUT_MS_READY", "300001"),
            ("KAGERO_HOOK_RESERVE_FRACTION", "1"),
            ("KAGERO_HOOK_RESERVE_FRACTION", "-0.1"),
            ("KAGERO_HOOK_RESERVE_FRACTION", "NaN"),
            ("KAGERO_HOOK_ALLOWED_PEERS", "10.0.0.0/8,10.0.0.0/33"),
            ("KAGERO_MICROVM_IMAGE_NAME", "a\"b"),
            ("KAGERO_OTLP_ENDPOINT_LGTM", "http://a\"b"),
            ("KAGERO_COLLECTOR_ARGS", "--config"),
            ("KAGERO_COLLECTOR_START", "later"),
            ("KAGERO_SAMPLE_INTERVAL_MS", "0"),
        ] {
            assert!(
                from_vars(USER, &[(key, value)]).is_err(),
                "{key}={value:?} must fail startup"
            );
        }
    }

    #[test]
    fn lookup_errors_fail_startup() {
        let cfg = Config::from_lookup(vec![], USER, &|k| {
            if k == "KAGERO_BACKEND" {
                anyhow::bail!("{k} is not valid Unicode")
            }
            Ok(None)
        });
        assert!(cfg.is_err());
    }

    #[test]
    fn per_hook_timeout_overrides_default() {
        let cfg = fixture();
        assert_eq!(cfg.hook_timeout("run"), Duration::from_millis(5000));
        assert_eq!(cfg.hook_timeout("suspend"), cfg.hook_timeout_default);
    }

    #[test]
    fn app_budget_reserves_ten_percent() {
        let cfg = fixture();
        assert_eq!(cfg.app_budget("run"), Duration::from_millis(4500));
    }

    #[test]
    fn peer_rule_cidr_matching() {
        let r = PeerRule::parse("10.0.0.0/8").unwrap();
        assert!(r.contains(&"10.0.0.1".parse().unwrap()));
        assert!(r.contains(&"10.255.255.255".parse().unwrap()));
        assert!(!r.contains(&"11.0.0.1".parse().unwrap()));

        let host = PeerRule::parse("127.0.0.1").unwrap();
        assert!(host.contains(&"127.0.0.1".parse().unwrap()));
        assert!(!host.contains(&"127.0.0.2".parse().unwrap()));

        let v6 = PeerRule::parse("fd00::/8").unwrap();
        assert!(v6.contains(&"fd00::1".parse().unwrap()));
        assert!(!v6.contains(&"fe80::1".parse().unwrap()));
        // Families never cross.
        assert!(!r.contains(&"::1".parse().unwrap()));

        assert!(PeerRule::parse("10.0.0.0/33").is_err());
        assert!(PeerRule::parse("not-an-ip/8").is_err());
        assert!(PeerRule::parse("::1/129").is_err());
    }

    #[test]
    fn endpoint_safe_rejects_template_breakers() {
        // Legitimate URLs pass — host, port, path, query, userinfo,
        // percent-encoding.
        for ok in [
            "http://127.0.0.1:4318",
            "https://xray.ap-northeast-1.amazonaws.com",
            "https://vpce-0abc.vpce.amazonaws.com/path?x=1&y=2",
            "https://user@host:4318/v1%20x",
        ] {
            assert!(endpoint_safe(ok), "should accept {ok:?}");
        }
        // Quote/escape break out of the quoted YAML slot; control and
        // non-ASCII corrupt or smuggle.
        for bad in [
            "http://a\"b",
            "http://a\\b",
            "http://a\nb",
            "http://a\tb",
            "http://exaｍple.com", // full-width ｍ
        ] {
            assert!(!endpoint_safe(bad), "should reject {bad:?}");
        }
    }

    #[test]
    fn peer_rule_zero_prefix_matches_everything_in_family() {
        // /0 must not panic on `u128 >> 128` (shift overflow).
        let any4 = PeerRule::parse("0.0.0.0/0").unwrap();
        assert!(any4.contains(&"1.2.3.4".parse().unwrap()));
        assert!(any4.contains(&"127.0.0.1".parse().unwrap()));
        assert!(!any4.contains(&"::1".parse().unwrap()));
        let any6 = PeerRule::parse("::/0").unwrap();
        assert!(any6.contains(&"2001:db8::1".parse().unwrap()));
        assert!(!any6.contains(&"10.0.0.1".parse().unwrap()));
    }
}
