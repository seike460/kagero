/**
 * The single backend-agnostic dashboard spec (ADR-010). Panels name
 * metrics SEMANTICALLY (OTel names via the injected `m` namer) and
 * reference log/trace RECIPES by name — never raw datasource queries.
 * Layout, units and thresholds are shared across both backends.
 */
import { findPrice } from "@kagero/pricing";
import type { MetricNamer } from "./otel-names.js";

// Cost panels multiply usage by LIST prices query-side (ADR-009).
// Prices come from the versioned table — never re-typed here. A failed
// lookup throws at generate time rather than silently drawing $0/h.
const ENTRY = findPrice("microvm", "us-east-1", "arm64");
if (!ENTRY) {
  throw new Error("microvm price entry missing for us-east-1/arm64 — check @kagero/pricing table");
}
const MEM_PRICE = ENTRY.prices.memoryGbSecond ?? Number.NaN;
const VCPU_PRICE = ENTRY.prices.vcpuSecond ?? Number.NaN;
if (!(MEM_PRICE > 0) || !(VCPU_PRICE > 0)) {
  throw new Error("microvm prices must be positive for the cost panel");
}

export interface MetricQuerySpec {
  /** Build the PromQL from the injected metric namer. */
  expr: (m: MetricNamer) => string;
  legend?: string;
}

export type PanelKind = "stat" | "timeseries" | "logs" | "traces" | "text";

export interface PanelSpec {
  kind: PanelKind;
  title: string;
  description?: string;
  span?: number; // of 24
  height?: number;
  unit?: string;
  /** PromQL targets (metric panels). */
  metrics?: MetricQuerySpec[];
  /** Recipe names (logs/traces panels). */
  recipes?: string[];
  /** Static body (text panels / 非対応 placeholders). */
  markdown?: string;
}

export interface RowSpec {
  title: string;
  /** CloudWatch Logs Insights panels collapse (query-cost discipline). */
  collapseOnCloudWatch?: boolean;
  panels: PanelSpec[];
}

export interface DashboardSpec {
  uid: string;
  title: string;
  description?: string;
  tags: string[];
  /** v1 refresh — 1m minimum per the query-cost rule. */
  refresh: string;
  rows: RowSpec[];
  /** Constant variables (e.g. baseline sizes for cost panels). */
  constants: { name: string; label: string; value: string }[];
}

const RI = "$__rate_interval";

export const microvmOverview: DashboardSpec = {
  uid: "kagero-microvm-overview",
  title: "kagero — MicroVM Overview",
  description:
    "Lambda MicroVM fleet health: lifecycle, burst usage, suspend/resume latency, cost estimate, logs and traces. All cost figures are ESTIMATES (ADR-009).",
  tags: ["kagero", "lambda", "microvm"],
  refresh: "1m",
  constants: [
    { name: "BASELINE_GIB", label: "Baseline GiB", value: "2" },
    { name: "BASELINE_VCPU", label: "Baseline vCPU", value: "1" },
  ],
  rows: [
    {
      title: "MicroVMs",
      panels: [
        {
          kind: "stat",
          title: "Active MicroVMs (rate)",
          description:
            "Concurrent RUNNING MicroVMs — the running_seconds counter increases once per second per active MicroVM.",
          span: 6,
          height: 6,
          unit: "none",
          metrics: [
            {
              expr: (m) => `sum(rate(${m("kagero.microvm.running_seconds")}[${RI}]))`,
              legend: "active",
            },
          ],
        },
        {
          kind: "timeseries",
          title: "Lifecycle transitions",
          description: "run/suspend/resume/terminate events per interval.",
          span: 9,
          height: 8,
          unit: "ops",
          metrics: [
            {
              expr: (m) =>
                `topk(10, sum by (kagero_lifecycle_event) (increase(${m("kagero.microvm.lifecycle_transitions")}[${RI}])))`,
            },
          ],
        },
        {
          kind: "timeseries",
          title: "Suspend duration p95",
          description: "Time in suspended state (measured on resume), 95th percentile.",
          span: 9,
          height: 8,
          unit: "s",
          metrics: [
            {
              expr: (m) =>
                `histogram_quantile(0.95, sum by (le) (rate(${m("kagero.microvm.suspend_duration_seconds")}_bucket[${RI}])))`,
              legend: "p95",
            },
          ],
        },
        {
          kind: "timeseries",
          title: "Burst usage above baseline",
          description: "Above-baseline vCPU-seconds and GiB-seconds rates.",
          span: 12,
          height: 8,
          metrics: [
            {
              expr: (m) => `sum(rate(${m("kagero.microvm.burst_vcpu_seconds")}[${RI}]))`,
              legend: "burst vCPU",
            },
            {
              expr: (m) => `sum(rate(${m("kagero.microvm.burst_memory_gib_seconds")}[${RI}]))`,
              legend: "burst GiB",
            },
          ],
        },
        {
          kind: "timeseries",
          title: "Degraded events (fail-soft)",
          description:
            "Lifecycle steps the agent could not complete cleanly — relay timeouts, collector errors, OTLP flush failures. Should stay 0. Counts only events that reached the OTLP path — when the collector itself is down the sole record is the stdout fallback (see the platform-logs panel in the Logs row; CloudWatch only).",
          span: 12,
          height: 6,
          unit: "ops",
          metrics: [
            {
              expr: (m) =>
                `sum(increase(${m("kagero.microvm.lifecycle_transitions")}{kagero_lifecycle_event="degraded"}[${RI}]))`,
              legend: "degraded",
            },
          ],
        },
      ],
    },
    {
      title: "Cost — estimate",
      panels: [
        {
          kind: "timeseries",
          title: "Estimated compute cost (USD/hour)",
          description:
            "ESTIMATE — baseline + burst at us-east-1 ARM list prices; excludes snapshot IO/storage, data transfer, free tier. Other regions are UNVERIFIED (PoC-09). Reconcile against CUR.",
          span: 16,
          height: 8,
          unit: "currencyUSD",
          metrics: [
            {
              expr: (m) =>
                `3600 * (sum(rate(${m("kagero.microvm.running_seconds")}[${RI}])) * ($BASELINE_GIB * ${MEM_PRICE} + $BASELINE_VCPU * ${VCPU_PRICE}) + sum(rate(${m("kagero.microvm.burst_memory_gib_seconds")}[${RI}])) * ${MEM_PRICE} + sum(rate(${m("kagero.microvm.burst_vcpu_seconds")}[${RI}])) * ${VCPU_PRICE})`,
              legend: "$/hour",
            },
          ],
        },
        {
          kind: "text",
          title: "What this estimate covers",
          span: 8,
          height: 8,
          markdown: [
            "**Estimate only (ADR-009).** Components priced here: baseline + burst compute.",
            "",
            "Not priced: snapshot loads/writes, suspended storage, data transfer, image storage.",
            "Prices are us-east-1 ARM list values — other regions are **unverified** (PoC-09).",
            "Reconcile against CUR; the @kagero/pricing package computes the full breakdown.",
          ].join("\n"),
        },
      ],
    },
    {
      title: "Logs",
      collapseOnCloudWatch: true,
      panels: [
        {
          kind: "logs",
          title: "Usage summaries",
          description: "Per-MicroVM usage facts emitted on suspend/terminate.",
          span: 12,
          height: 9,
          recipes: ["usage-summary"],
        },
        {
          kind: "logs",
          title: "Degraded lifecycle events",
          description: "Fail-soft path taken — investigate any non-empty output.",
          span: 12,
          height: 9,
          recipes: ["lifecycle-degraded"],
        },
        {
          kind: "logs",
          title: "Degraded events — platform fallback",
          description:
            "stdout fallback copy of kagero.lifecycle.degraded events, read from the MicroVM's own platform log group — the only surviving record when the collector was down. CloudWatch only; on LGTM there is no stdout→Loki route, so this panel is 非対応.",
          span: 12,
          height: 9,
          recipes: ["platform-degraded"],
        },
      ],
    },
    {
      title: "Traces",
      panels: [
        {
          kind: "traces",
          title: "MicroVM lifecycle traces",
          description: "Tempo traces for kagero spans (hook relay, flush).",
          span: 24,
          height: 9,
          recipes: ["microvm-traces"],
        },
      ],
    },
  ],
};
