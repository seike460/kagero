/**
 * Alert rules from the same spec (architecture.md §7).
 *  - LGTM: a strict Prometheus rule file — {groups:[...]} only, so it
 *    loads into a Mimir ruler / Grafana provisioning without surprises.
 *  - CloudWatch: a manifest — CloudWatch alarms cannot evaluate raw
 *    PromQL, so entries are listed for parity with supported:false and
 *    the CDK (v0.5) provisioning path noted.
 */
import type { BackendAdapter } from "./adapters.js";
import { assertSafeSelector } from "./otel-names.js";

export interface AlertRuleSpec {
  name: string;
  severity: "warning" | "critical";
  /** Seconds the condition must hold. */
  forSeconds: number;
  summary: string;
  expr: (m: (otel: string) => string) => string;
}

const RI = "5m";

export const alertRules: AlertRuleSpec[] = [
  {
    name: "KageroDegradedLifecycle",
    severity: "warning",
    forSeconds: 300,
    summary: "kagero agent took the degraded path (relay/flush/collector failure)",
    expr: (m) =>
      `sum(increase(${m("kagero.microvm.lifecycle_transitions")}{kagero_lifecycle_event="degraded"}[${RI}])) > 0`,
  },
  {
    name: "KageroNoMicrovmTelemetry",
    severity: "warning",
    forSeconds: 600,
    summary: "no MicroVM telemetry reaching the backend while the fleet should be active",
    // running_seconds is pushed every USAGE_PUSH_INTERVAL (60s) while
    // RUNNING plus on suspend/terminate — 10m absent means really absent.
    expr: (m) => `absent_over_time(${m("kagero.microvm.running_seconds")}[10m])`,
  },
  {
    name: "KageroSuspendDurationHigh",
    severity: "warning",
    forSeconds: 900,
    summary: "suspend duration p95 above 60s — resume path may be degrading",
    expr: (m) =>
      `histogram_quantile(0.95, sum by (le) (rate(${m("kagero.microvm.suspend_duration_seconds")}_bucket[${RI}]))) > 60`,
  },
];

interface PromRule {
  alert: string;
  expr: string;
  for: string;
  labels: { severity: string };
  annotations: { summary: string };
}

/** Strict Prometheus rule-file shape — nothing else at top level. */
export interface PromRuleFile {
  groups: { name: string; rules: PromRule[] }[];
}

export function buildPromRuleFile(adapter: BackendAdapter): PromRuleFile {
  return {
    groups: [
      {
        name: "kagero-microvm",
        rules: alertRules.map((r) => ({
          alert: r.name,
          expr: assertSafeSelector(r.expr(adapter.metric)),
          for: `${r.forSeconds}s`,
          labels: { severity: r.severity },
          annotations: { summary: r.summary },
        })),
      },
    ],
  };
}

/** CloudWatch parity manifest — NOT a loadable rule file. */
export interface CloudwatchAlertManifest {
  spec: "kagero-alerts/v1";
  backend: "cloudwatch";
  note: string;
  rules: {
    name: string;
    expr: string;
    forSeconds: number;
    severity: string;
    summary: string;
    supported: false;
    unsupportedReason: string;
  }[];
}

export function buildCloudwatchManifest(adapter: BackendAdapter): CloudwatchAlertManifest {
  return {
    spec: "kagero-alerts/v1",
    backend: "cloudwatch",
    note: "CloudWatch alarms cannot evaluate raw PromQL. These rules exist for parity with the LGTM rule file; provision equivalents as CloudWatch alarms from CDK (v0.5) or Metrics Insights.",
    rules: alertRules.map((r) => ({
      name: r.name,
      expr: assertSafeSelector(r.expr(adapter.metric)),
      forSeconds: r.forSeconds,
      severity: r.severity,
      summary: r.summary,
      supported: false,
      unsupportedReason: "CloudWatch alarms do not evaluate PromQL — provision via CDK (v0.5).",
    })),
  };
}

export function buildAlertOutput(adapter: BackendAdapter): object {
  return adapter.id === "lgtm" ? buildPromRuleFile(adapter) : buildCloudwatchManifest(adapter);
}
