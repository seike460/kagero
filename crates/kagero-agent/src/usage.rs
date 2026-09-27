//! Usage recording (microvms.md §9): sample cgroup v2 (fallback /proc),
//! accumulate RUNNING seconds and above-baseline burst. The agent never
//! applies prices (ADR-009) — it ships usage facts only.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::sync::Mutex;
use tracing::debug;

use crate::telemetry::unix_nanos;

/// Histogram bounds for suspended-duration observations (seconds).
pub const SUSPEND_BOUNDS: [f64; 9] = [1.0, 5.0, 10.0, 30.0, 60.0, 300.0, 600.0, 1800.0, 3600.0];

/// How often the sampler pushes usage counters to the collector while
/// RUNNING — suspend/terminate would otherwise be the only pushes, and
/// dashboards/alerts need a continuous series.
pub const USAGE_PUSH_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub struct UsageSnapshot {
    pub running_seconds: f64,
    pub burst_vcpu_seconds: f64,
    pub burst_gib_seconds: f64,
    pub suspend_seconds: f64,
    pub resumes: u64,
    pub suspends: u64,
    /// Suspend-duration histogram in OTLP shape: len = bounds+1, each
    /// bucket holds its OWN count (bucket i = (bounds[i-1], bounds[i]]),
    /// last bucket = observations above the last bound). The sum of
    /// suspend_buckets must equal suspend_count — exporting cumulative
    /// (le-style) counts would violate the OTLP data model and break
    /// backends that re-cumulate. suspend_sum is the OTLP `sum`.
    pub suspend_count: u64,
    pub suspend_sum: f64,
    pub suspend_buckets: Vec<u64>,
}

pub struct Usage {
    inner: Mutex<Inner>,
    running: AtomicBool,
    cgroup: PathBuf,
    baseline_vcpu: f64,
    baseline_gib: f64,
}

struct Inner {
    snapshot: UsageSnapshot,
    last_cpu_usec: Option<u64>,
    suspend_started_nanos: Option<u64>,
}

impl Usage {
    pub fn new(cgroup_path: Option<&str>, baseline_vcpu: f64, baseline_gib: f64) -> Arc<Self> {
        Arc::new(Usage {
            inner: Mutex::new(Inner {
                snapshot: UsageSnapshot {
                    running_seconds: 0.0,
                    burst_vcpu_seconds: 0.0,
                    burst_gib_seconds: 0.0,
                    suspend_seconds: 0.0,
                    resumes: 0,
                    suspends: 0,
                    suspend_count: 0,
                    suspend_sum: 0.0,
                    suspend_buckets: vec![0; SUSPEND_BOUNDS.len() + 1],
                },
                last_cpu_usec: None,
                suspend_started_nanos: None,
            }),
            running: AtomicBool::new(false),
            cgroup: cgroup_path
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/sys/fs/cgroup")),
            baseline_vcpu,
            baseline_gib,
        })
    }

    pub fn set_running(&self, r: bool) {
        self.running.store(r, Ordering::Relaxed);
    }

    pub async fn mark_suspend(&self) {
        let mut g = self.inner.lock().await;
        g.snapshot.suspends += 1;
        // A duplicate /suspend while an interval is still open must not
        // reset the start — that would silently shorten the observation.
        if g.suspend_started_nanos.is_none() {
            g.suspend_started_nanos = Some(unix_nanos());
        }
        self.running.store(false, Ordering::Relaxed);
    }

    /// Returns the wall-clock seconds spent suspended (clock-skew tolerant:
    /// negative deltas are clamped to zero and reported by the caller).
    pub async fn mark_resume(&self) -> f64 {
        let mut g = self.inner.lock().await;
        g.snapshot.resumes += 1;
        self.running.store(true, Ordering::Relaxed);
        // No open interval (retry / forged /resume): count the resume but
        // do NOT record a bogus 0s histogram observation.
        let Some(t0) = g.suspend_started_nanos.take() else {
            return 0.0;
        };
        let secs = unix_nanos().saturating_sub(t0) as f64 / 1e9;
        record_suspend_observation(&mut g.snapshot, secs);
        secs
    }

    /// Suspend-duration histogram for OTLP export: (count, sum,
    /// per-bucket counts). Buckets are NOT cumulative — backends
    /// re-cumulate them into le series.
    pub async fn suspend_histogram(&self) -> (u64, f64, Vec<u64>) {
        let g = self.inner.lock().await;
        (
            g.snapshot.suspend_count,
            g.snapshot.suspend_sum,
            g.snapshot.suspend_buckets.clone(),
        )
    }

    /// Close an open suspend interval — /terminate can arrive while the VM
    /// is suspended, which would otherwise leave suspend_seconds uncounted.
    pub async fn finalize(&self) {
        let mut g = self.inner.lock().await;
        if let Some(t0) = g.suspend_started_nanos.take() {
            let secs = unix_nanos().saturating_sub(t0) as f64 / 1e9;
            record_suspend_observation(&mut g.snapshot, secs);
        }
        self.running.store(false, Ordering::Relaxed);
    }

    pub async fn snapshot(&self) -> UsageSnapshot {
        self.inner.lock().await.snapshot.clone()
    }

    fn read_cpu_usec(&self) -> Option<u64> {
        // cgroup v2: cpu.stat "usage_usec"
        let stat = self.cgroup.join("cpu.stat");
        if let Ok(s) = std::fs::read_to_string(&stat) {
            for line in s.lines() {
                if let Some(v) = line.strip_prefix("usage_usec ") {
                    return v.trim().parse().ok();
                }
            }
        }
        // /proc fallback: busy jiffies (VM view) — idle/iowait excluded.
        if let Ok(s) = std::fs::read_to_string("/proc/stat")
            && let Some(first) = s.lines().next()
            && let Some(usec) = proc_stat_busy_usec(first)
        {
            return Some(usec);
        }
        None
    }

    fn read_memory_bytes(&self) -> Option<u64> {
        let cur = self.cgroup.join("memory.current");
        if let Ok(s) = std::fs::read_to_string(&cur) {
            return s.trim().parse().ok();
        }
        // /proc fallback: MemTotal - MemAvailable.
        if let Ok(s) = std::fs::read_to_string("/proc/meminfo") {
            let mut total = None;
            let mut avail = None;
            for line in s.lines() {
                if let Some(v) = line.strip_prefix("MemTotal:") {
                    total = v
                        .trim()
                        .strip_suffix("kB")
                        .and_then(|x| x.trim().parse::<u64>().ok());
                }
                if let Some(v) = line.strip_prefix("MemAvailable:") {
                    avail = v
                        .trim()
                        .strip_suffix("kB")
                        .and_then(|x| x.trim().parse::<u64>().ok());
                }
            }
            if let (Some(t), Some(a)) = (total, avail) {
                // MemAvailable > MemTotal would underflow — saturate.
                return Some(t.saturating_sub(a) * 1024);
            }
        }
        None
    }

    /// Background sampler: call once after /run. Also pushes the usage
    /// counters upstream every `push_interval` while RUNNING — without it
    /// suspend/terminate would be the only pushes and every rate() panel
    /// would go blank between events (fail-soft: a failed push only logs
    /// a stdout event, never blocks sampling).
    pub fn spawn_sampler(
        self: &Arc<Self>,
        interval: Duration,
        telemetry: Arc<crate::telemetry::OtlpSender>,
        push_interval: Duration,
    ) {
        let u = Arc::clone(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            // Measure real elapsed time between samples — a skipped tick
            // would otherwise count one interval for many seconds of CPU.
            let mut last = std::time::Instant::now();
            let mut pushed = std::time::Instant::now();
            loop {
                ticker.tick().await;
                if !u.running.load(Ordering::Relaxed) {
                    last = std::time::Instant::now();
                    continue;
                }
                let now = std::time::Instant::now();
                let dt = now.saturating_duration_since(last).as_secs_f64();
                last = now;
                let mut g = u.inner.lock().await;
                g.snapshot.running_seconds += dt;

                if let Some(cpu_usec) = u.read_cpu_usec() {
                    if let Some(prev) = g.last_cpu_usec {
                        let delta_usec = cpu_usec.saturating_sub(prev) as f64;
                        let vcpu_used = delta_usec / (dt * 1e6);
                        let burst = (vcpu_used - u.baseline_vcpu).max(0.0);
                        g.snapshot.burst_vcpu_seconds += burst * dt;
                    }
                    g.last_cpu_usec = Some(cpu_usec);
                }
                if let Some(mem) = u.read_memory_bytes() {
                    let gib = mem as f64 / (1024.0 * 1024.0 * 1024.0);
                    let burst = (gib - u.baseline_gib).max(0.0);
                    g.snapshot.burst_gib_seconds += burst * dt;
                }
                let snap = g.snapshot.clone();
                drop(g);

                if pushed.elapsed() >= push_interval {
                    pushed = std::time::Instant::now();
                    if let Err(e) = telemetry
                        .usage_metrics(
                            snap.running_seconds,
                            snap.burst_vcpu_seconds,
                            snap.burst_gib_seconds,
                            Duration::from_secs(3),
                        )
                        .await
                    {
                        crate::telemetry::stdout_event(
                            "kagero.usage.push_failed",
                            None,
                            Some(&format!("{e:#}")),
                            serde_json::Map::new(),
                        );
                    }
                }
                debug!("usage sampled");
            }
        });
    }
}

fn record_suspend_observation(snap: &mut UsageSnapshot, secs: f64) {
    snap.suspend_seconds += secs;
    snap.suspend_count += 1;
    snap.suspend_sum += secs;
    // Per-bucket count — OTLP requires sum(bucketCounts) == count.
    for (i, bound) in SUSPEND_BOUNDS.iter().enumerate() {
        if secs <= *bound {
            snap.suspend_buckets[i] += 1;
            return;
        }
    }
    // Above the largest bound → the last (+Inf) bucket.
    if let Some(last) = snap.suspend_buckets.last_mut() {
        *last += 1;
    }
}

/// `/proc/stat` "cpu" line → consumed-CPU µs: user+nice+system+
/// irq+softirq+steal jiffies. idle and iowait are excluded — they are
/// unspent time, and with them the fallback would report ~ncpu vCPU
/// permanently (over-counting burst_vcpu_seconds). guest is already
/// counted inside user, so it is not added again.
/// jiffies → µs assuming USER_HZ=100 (standard on arm64/x86_64).
fn proc_stat_busy_usec(first_line: &str) -> Option<u64> {
    let parts: Vec<u64> = first_line
        .split_whitespace()
        .skip(1)
        .take(8)
        .filter_map(|p| p.parse().ok())
        .collect();
    if parts.len() < 8 {
        return None;
    }
    // fields: user nice system idle iowait irq softirq steal
    let busy: u64 = parts[0] + parts[1] + parts[2] + parts[5] + parts[6] + parts[7];
    Some(busy * 10_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn suspend_resume_bookkeeping() {
        let u = Usage::new(Some("/nonexistent"), 1.0, 2.0);
        u.set_running(true);
        u.mark_suspend().await;
        tokio::time::sleep(Duration::from_millis(10)).await;
        let slept = u.mark_resume().await;
        assert!(slept >= 0.005, "slept={slept}");
        let s = u.snapshot().await;
        assert_eq!(s.suspends, 1);
        assert_eq!(s.resumes, 1);
        assert!(s.suspend_seconds >= 0.005);
    }

    #[test]
    fn histogram_buckets_are_per_bucket_not_cumulative() {
        let mut s = UsageSnapshot {
            running_seconds: 0.0,
            burst_vcpu_seconds: 0.0,
            burst_gib_seconds: 0.0,
            suspend_seconds: 0.0,
            resumes: 0,
            suspends: 0,
            suspend_count: 0,
            suspend_sum: 0.0,
            suspend_buckets: vec![0; SUSPEND_BOUNDS.len() + 1],
        };
        record_suspend_observation(&mut s, 7.0); // lands in (5, 10]
        record_suspend_observation(&mut s, 0.5); // lands in (-inf, 1]
        record_suspend_observation(&mut s, 90_000.0); // lands in +Inf bucket
        let n = SUSPEND_BOUNDS.len();
        assert_eq!(s.suspend_count, 3);
        // OTLP invariant: sum(bucket_counts) == count.
        assert_eq!(s.suspend_buckets.iter().sum::<u64>(), s.suspend_count);
        // 7s → bucket index 2 (bounds[2]=10): exactly one bucket +1.
        assert_eq!(s.suspend_buckets[2], 1);
        assert_eq!(s.suspend_buckets[0], 1); // 0.5s → (-inf, 1]
        assert_eq!(s.suspend_buckets[n], 1); // 90000s → +Inf bucket
        // No other bucket may carry a count (cumulative would fill 3..n).
        for (i, c) in s.suspend_buckets.iter().enumerate() {
            if ![0, 2, n].contains(&i) {
                assert_eq!(*c, 0, "bucket {i} must be empty");
            }
        }
    }

    #[tokio::test]
    async fn resume_without_open_suspend_records_no_observation() {
        let u = Usage::new(Some("/nonexistent"), 1.0, 2.0);
        let secs = u.mark_resume().await; // forged / duplicate resume
        assert_eq!(secs, 0.0);
        let s = u.snapshot().await;
        assert_eq!(s.resumes, 1);
        assert_eq!(s.suspend_count, 0, "no observation without open interval");
        assert_eq!(s.suspend_buckets.iter().sum::<u64>(), 0);
    }

    #[test]
    fn proc_stat_fallback_excludes_idle_jiffies() {
        // user=1 nice=2 system=4 idle=100 iowait=50 irq=8 softirq=16
        // steal=32 guest=64 guest_nice=128 — guest fields are already
        // inside user/nice, so they must not be added again.
        let line = "cpu  1 2 4 100 50 8 16 32 64 128";
        assert_eq!(
            proc_stat_busy_usec(line),
            Some((1 + 2 + 4 + 8 + 16 + 32) * 10_000)
        );
    }

    #[tokio::test]
    async fn duplicate_suspend_keeps_original_start() {
        let u = Usage::new(Some("/nonexistent"), 1.0, 2.0);
        u.mark_suspend().await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        u.mark_suspend().await; // duplicate while open — must not reset t0
        let slept = u.mark_resume().await;
        // ~20ms elapsed since the FIRST suspend, not since the second.
        assert!(slept >= 0.015, "slept={slept}");
        let s = u.snapshot().await;
        assert_eq!(s.suspends, 2);
        assert_eq!(s.suspend_count, 1, "one interval → one observation");
    }
}
