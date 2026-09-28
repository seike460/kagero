//! Telemetry egress: OTLP/JSON to the in-VM collector, plus JSON lines on
//! stdout for failures that must reach CloudWatch Logs even when the
//! collector path is down (microvms.md §7: "送れなかったことは標準出力に記録").

use anyhow::Result;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::semconv_gen as sem;

pub(crate) fn unix_nanos() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}

pub(crate) fn attr(key: &str, value: impl Into<Value>) -> Value {
    let v = value.into();
    match v {
        Value::String(s) => json!({"key": key, "value": {"stringValue": s}}),
        Value::Number(n) => {
            if n.is_f64() {
                json!({"key": key, "value": {"doubleValue": n}})
            } else {
                json!({"key": key, "value": {"intValue": n.to_string()}})
            }
        }
        Value::Bool(b) => json!({"key": key, "value": {"boolValue": b}}),
        other => json!({"key": key, "value": {"stringValue": other.to_string()}}),
    }
}

/// One JSON event on stdout — the last-resort channel.
#[derive(Serialize)]
struct StdoutEvent<'a> {
    ts: u64,
    level: &'a str,
    event: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    hook: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a str>,
    #[serde(flatten)]
    extra: serde_json::Map<String, Value>,
}

pub fn stdout_event(
    event: &str,
    hook: Option<&str>,
    error: Option<&str>,
    extra: serde_json::Map<String, Value>,
) {
    let e = StdoutEvent {
        ts: unix_nanos(),
        level: if error.is_some() { "warn" } else { "info" },
        event,
        hook,
        error,
        extra,
    };
    // Never fail the workload on logging itself: ignore write errors so a
    // broken stdout pipe cannot panic PID 1 (panic = "abort" in release).
    use std::io::Write as _;
    let line = serde_json::to_string(&e).unwrap_or_else(|_| "{}".into());
    let _ = writeln!(std::io::stdout().lock(), "{line}");
}

/// OTLP/HTTP sender; synchronous callers await each POST (ADR-006).
pub struct OtlpSender {
    base: String,
    client: reqwest::Client,
    timeout: Duration,
    failures: AtomicU64,
    /// Cumulative-temporality series start — fixed at sender creation.
    start_nanos: u64,
    /// Cumulative counts per counter series. A cumulative counter that
    /// always reports 1 is a flat series — increase()/rate() stay at 0
    /// forever, so each series must carry its real running total.
    counters: Mutex<HashMap<String, u64>>,
}

impl OtlpSender {
    pub fn new(otlp_base_url: String, timeout: Duration) -> Self {
        Self {
            base: otlp_base_url.trim_end_matches('/').to_string(),
            client: crate::local_http_client(),
            timeout,
            failures: AtomicU64::new(0),
            start_nanos: unix_nanos(),
            counters: Mutex::new(HashMap::new()),
        }
    }

    /// Bump a cumulative counter series and return its running total.
    /// Key is metric name + attribute signature — one series per combo.
    fn bump(&self, key: String) -> u64 {
        let mut m = self.counters.lock().unwrap_or_else(|e| e.into_inner());
        let c = m.entry(key).or_insert(0);
        *c += 1;
        *c
    }

    pub fn failure_count(&self) -> u64 {
        self.failures.load(Ordering::Relaxed)
    }

    async fn post(&self, path: &str, body: &Value, budget: Duration) -> Result<()> {
        let res = self
            .client
            .post(format!("{}{}", self.base, path))
            .json(body)
            .timeout(budget.min(self.timeout))
            .send()
            .await;
        match res {
            Ok(r) if r.status().is_success() => Ok(()),
            Ok(r) => {
                self.failures.fetch_add(1, Ordering::Relaxed);
                anyhow::bail!("collector {}: HTTP {}", path, r.status())
            }
            Err(e) => {
                self.failures.fetch_add(1, Ordering::Relaxed);
                Err(e.into())
            }
        }
    }

    /// Fire a lifecycle event: one log record + one counter datapoint.
    /// `extra_attrs` lands on the LOG only — the metric datapoint carries
    /// just `kagero.lifecycle.event`, because high-cardinality values on a
    /// metric series violate ADR-008 (CloudWatch PromQL 500-series cap).
    ///
    /// `budget` bounds the WHOLE call — the two serial POSTs share it via
    /// an internal deadline, so the second POST only gets what the first
    /// left over.
    pub async fn lifecycle_event(
        &self,
        name: &str,
        extra_attrs: &[Value],
        budget: Duration,
    ) -> Result<()> {
        let deadline = std::time::Instant::now() + budget;
        let remaining =
            |d: std::time::Instant| d.saturating_duration_since(std::time::Instant::now());
        if budget.is_zero() {
            return Ok(()); // a zero-timeout POST would only inflate the failure counter
        }
        let now = unix_nanos();
        let mut attrs = vec![attr(sem::ATTR_KAGERO_LIFECYCLE_EVENT, name)];
        attrs.extend_from_slice(extra_attrs);
        let metric_attrs = vec![attr(sem::ATTR_KAGERO_LIFECYCLE_EVENT, name)];

        let logs = json!({
            "resourceLogs": [{
                "scopeLogs": [{
                    "scope": {"name": "kagero-agent"},
                    "logRecords": [{
                        "timeUnixNano": now.to_string(),
                        "severityText": "INFO",
                        "body": {"stringValue": format!("kagero.lifecycle.{name}")},
                        "attributes": attrs,
                    }],
                }],
            }],
        });
        self.post("/v1/logs", &logs, remaining(deadline)).await?;

        let count = self.bump(format!("transitions:{name}"));
        let metrics = json!({
            "resourceMetrics": [{
                "scopeMetrics": [{
                    "scope": {"name": "kagero-agent"},
                    "metrics": [{
                        "name": sem::METRIC_KAGERO_MICROVM_LIFECYCLE_TRANSITIONS,
                        "unit": "{transition}",
                        "sum": {
                            "aggregationTemporality": 2,
                            "isMonotonic": true,
                            "dataPoints": [{
                                "attributes": metric_attrs,
                                "startTimeUnixNano": self.start_nanos.to_string(),
                                "timeUnixNano": now.to_string(),
                                "asInt": count.to_string(),
                            }],
                        },
                    }],
                }],
            }],
        });
        let left = remaining(deadline);
        if left.is_zero() {
            return Ok(());
        }
        self.post("/v1/metrics", &metrics, left).await
    }

    /// Per-hook outcome counter (kagero.hook.name / kagero.hook.status —
    /// both registry-allowed metric labels).
    pub async fn hook_result(&self, hook: &str, status: &str, budget: Duration) -> Result<()> {
        let now = unix_nanos();
        let count = self.bump(format!("hook:{hook}:{status}"));
        let attrs = vec![
            attr(sem::ATTR_KAGERO_HOOK_NAME, hook),
            attr(sem::ATTR_KAGERO_HOOK_STATUS, status),
        ];
        let metrics = json!({
            "resourceMetrics": [{
                "scopeMetrics": [{
                    "scope": {"name": "kagero-agent"},
                    "metrics": [{
                        "name": sem::METRIC_KAGERO_MICROVM_HOOK_RESULTS,
                        "unit": "{hook}",
                        "sum": {
                            "aggregationTemporality": 2,
                            "isMonotonic": true,
                            "dataPoints": [{
                                "attributes": attrs,
                                "startTimeUnixNano": self.start_nanos.to_string(),
                                "timeUnixNano": now.to_string(),
                                "asInt": count.to_string(),
                            }],
                        },
                    }],
                }],
            }],
        });
        self.post("/v1/metrics", &metrics, budget).await
    }

    /// Periodic + final usage counters (microvms.md §9).
    pub async fn usage_metrics(
        &self,
        running_seconds: f64,
        burst_vcpu_seconds: f64,
        burst_gib_seconds: f64,
        budget: Duration,
    ) -> Result<()> {
        let now = unix_nanos();
        let start = self.start_nanos.to_string();
        let point = |value: f64| {
            json!({
                "startTimeUnixNano": start,
                "timeUnixNano": now.to_string(),
                "asDouble": value,
            })
        };
        let metrics = json!({
            "resourceMetrics": [{
                "scopeMetrics": [{
                    "scope": {"name": "kagero-agent"},
                    "metrics": [
                        {"name": sem::METRIC_KAGERO_MICROVM_RUNNING_SECONDS,
                         "unit": "s",
                         "sum": {"aggregationTemporality": 2, "isMonotonic": true,
                                 "dataPoints": [point(running_seconds)]}},
                        {"name": sem::METRIC_KAGERO_MICROVM_BURST_VCPU_SECONDS,
                         "unit": "{vcpu}s",
                         "sum": {"aggregationTemporality": 2, "isMonotonic": true,
                                 "dataPoints": [point(burst_vcpu_seconds)]}},
                        {"name": sem::METRIC_KAGERO_MICROVM_BURST_MEMORY_GIB_SECONDS,
                         "unit": "{gib}s",
                         "sum": {"aggregationTemporality": 2, "isMonotonic": true,
                                 "dataPoints": [point(burst_gib_seconds)]}},
                    ],
                }],
            }],
        });
        self.post("/v1/metrics", &metrics, budget).await
    }

    /// Suspend-duration histogram, cumulative temporality (updated on
    /// resume and at finalize). bucket_counts are per-bucket (NOT
    /// cumulative) — len = bounds+1, sum == count — and the collector
    /// re-cumulates them into le series for histogram_quantile.
    pub async fn suspend_duration(
        &self,
        count: u64,
        sum: f64,
        bucket_counts: &[u64],
        bounds: &[f64],
        budget: Duration,
    ) -> Result<()> {
        let now = unix_nanos();
        let metrics = json!({
            "resourceMetrics": [{
                "scopeMetrics": [{
                    "scope": {"name": "kagero-agent"},
                    "metrics": [{
                        "name": sem::METRIC_KAGERO_MICROVM_SUSPEND_DURATION_SECONDS,
                        "unit": "s",
                        "histogram": {
                            "aggregationTemporality": 2,
                            "dataPoints": [{
                                "startTimeUnixNano": self.start_nanos.to_string(),
                                "timeUnixNano": now.to_string(),
                                "count": count.to_string(),
                                "sum": sum,
                                "bucketCounts": bucket_counts.iter().map(u64::to_string).collect::<Vec<_>>(),
                                "explicitBounds": bounds,
                            }],
                        },
                    }],
                }],
            }],
        });
        self.post("/v1/metrics", &metrics, budget).await
    }

    /// Usage summary log line — the per-instance cost record (§9 "要約ログ").
    /// Carries instance + tenancy attributes, which live on logs (never metrics).
    pub async fn usage_summary_log(
        &self,
        fields: &serde_json::Map<String, Value>,
        budget: Duration,
    ) -> Result<()> {
        let now = unix_nanos();
        let attrs: Vec<Value> = fields.iter().map(|(k, v)| attr(k, v.clone())).collect();
        let logs = json!({
            "resourceLogs": [{
                "scopeLogs": [{
                    "scope": {"name": "kagero-agent"},
                    "logRecords": [{
                        "timeUnixNano": now.to_string(),
                        "severityText": "INFO",
                        "body": {"stringValue": "kagero.usage.summary"},
                        "attributes": attrs,
                    }],
                }],
            }],
        });
        self.post("/v1/logs", &logs, budget).await
    }
}
