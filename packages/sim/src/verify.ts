/**
 * Assertion helpers over the evidence the simulator collects: OTLP
 * captures and the app's hook-arrival log.
 */
import { ATTR_KAGERO_LIFECYCLE_EVENT, METRIC_LABEL_FORBIDDEN } from "@kagero/semconv";
import type { HookResult } from "./hooks.js";
import type { OtlpCapture } from "./mock-otlp.js";

/** OTLP metric data kinds that carry `dataPoints`. */
const POINT_KINDS = ["sum", "gauge", "histogram", "exponentialHistogram", "summary"] as const;

interface OtlpMetric {
  name?: unknown;
  sum?: { aggregationTemporality?: unknown; isMonotonic?: unknown };
}

interface OtlpDataPoint {
  attributes?: unknown;
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const isObject = (v: unknown): v is object => typeof v === "object" && v !== null;

/** Every metric in one OTLP metrics payload, across all resources and scopes. */
function* metricsIn(payload: unknown): Generator<OtlpMetric> {
  for (const rm of asArray((payload as { resourceMetrics?: unknown })?.resourceMetrics)) {
    for (const sm of asArray((rm as { scopeMetrics?: unknown })?.scopeMetrics)) {
      for (const m of asArray((sm as { metrics?: unknown })?.metrics)) {
        if (isObject(m)) yield m;
      }
    }
  }
}

/** Every metric across the captured /v1/metrics payloads. */
function* capturedMetrics(captures: OtlpCapture[]): Generator<OtlpMetric> {
  for (const c of captures) {
    if (c.path === "/v1/metrics") yield* metricsIn(c.body);
  }
}

/** Every datapoint of one metric, whatever its data kind. */
function* dataPointsOf(metric: OtlpMetric): Generator<OtlpDataPoint> {
  for (const kind of POINT_KINDS) {
    const data = (metric as Record<string, unknown>)[kind] as { dataPoints?: unknown } | undefined;
    for (const p of asArray(data?.dataPoints)) {
      if (isObject(p)) yield p;
    }
  }
}

/** String value of attribute `key` in an OTLP attribute list. */
function stringAttr(attrs: unknown, key: string): string | undefined {
  for (const a of asArray(attrs)) {
    const attr = a as { key?: unknown; value?: { stringValue?: unknown } } | null;
    if (attr?.key === key && typeof attr.value?.stringValue === "string") {
      return attr.value.stringValue;
    }
  }
  return undefined;
}

/** Every attribute key anywhere inside an OTLP metrics payload:
 * resource attributes, instrumentation-scope attributes, AND datapoint
 * attributes (all three can end up as labels). */
export function metricAttrKeys(payload: unknown): string[] {
  const keys: string[] = [];
  const collect = (attrs: unknown) => {
    for (const a of asArray(attrs)) {
      const key = (a as { key?: unknown } | null)?.key;
      if (typeof key === "string") keys.push(key);
    }
  };
  for (const rm of asArray((payload as { resourceMetrics?: unknown })?.resourceMetrics)) {
    collect((rm as { resource?: { attributes?: unknown } })?.resource?.attributes);
    for (const sm of asArray((rm as { scopeMetrics?: unknown })?.scopeMetrics)) {
      collect((sm as { scope?: { attributes?: unknown } })?.scope?.attributes);
    }
  }
  for (const m of metricsIn(payload)) {
    for (const p of dataPointsOf(m)) collect(p.attributes);
  }
  return keys;
}

/** Forbidden attribute keys (ADR-008) found on metric payloads. */
export function forbiddenMetricKeys(captures: OtlpCapture[]): string[] {
  const bad = new Set<string>();
  for (const c of captures) {
    if (c.path !== "/v1/metrics") continue;
    for (const k of metricAttrKeys(c.body)) {
      if ((METRIC_LABEL_FORBIDDEN as readonly string[]).includes(k)) bad.add(k);
    }
  }
  return [...bad];
}

/** String values of one resource attribute across all captures of one
 * path — e.g. "did logs carry kagero.tenant.id=tenant-a?". */
export function resourceAttrValues(captures: OtlpCapture[], path: string, key: string): string[] {
  const out: string[] = [];
  for (const c of captures) {
    if (c.path !== path) continue;
    const groups =
      (c.body as {
        resourceMetrics?: unknown[];
        resourceLogs?: unknown[];
        resourceSpans?: unknown[];
      }) ?? {};
    for (const groupName of ["resourceMetrics", "resourceLogs", "resourceSpans"]) {
      const list = groups[groupName as keyof typeof groups];
      if (!Array.isArray(list)) continue;
      for (const g of list) {
        const attrs = (g as { resource?: { attributes?: unknown[] } })?.resource?.attributes;
        if (!Array.isArray(attrs)) continue;
        for (const a of attrs) {
          const attr = a as { key?: string; value?: { stringValue?: string } };
          if (attr?.key === key && typeof attr.value?.stringValue === "string") {
            out.push(attr.value.stringValue);
          }
        }
      }
    }
  }
  return out;
}

/** Metric names found across all captured /v1/metrics payloads. */
export function metricNames(captures: OtlpCapture[]): string[] {
  const names = new Set<string>();
  for (const m of capturedMetrics(captures)) {
    if (typeof m.name === "string" && m.name) names.add(m.name);
  }
  return [...names];
}

export function isAppHookLog(c: OtlpCapture | undefined, hook: string): boolean {
  if (c?.path !== "/v1/logs") return false;
  const rls = (c.body as { resourceLogs?: unknown[] })?.resourceLogs ?? [];
  for (const rl of rls) {
    const scopeLogs = (rl as { scopeLogs?: unknown[] })?.scopeLogs ?? [];
    for (const sl of scopeLogs) {
      for (const rec of (
        sl as {
          logRecords?: { attributes?: { key?: string; value?: { stringValue?: string } }[] }[];
        }
      ).logRecords ?? []) {
        for (const a of rec.attributes ?? []) {
          if (a.key === "sim.hook" && a.value?.stringValue === hook) return true;
        }
      }
    }
  }
  return false;
}

export function isLifecycle(c: OtlpCapture | undefined, event: string): boolean {
  if (c?.path !== "/v1/metrics") return false;
  for (const m of metricsIn(c.body)) {
    for (const p of dataPointsOf(m)) {
      if (stringAttr(p.attributes, ATTR_KAGERO_LIFECYCLE_EVENT) === event) return true;
    }
  }
  return false;
}

/**
 * Names of `sum` metrics that are NOT monotonic+cumulative. The
 * dashboards' Prometheus selectors assume the default OTLP→Prom
 * translation (`UnderscoreEscapingWithSuffixes`), which appends
 * `_total` to monotonic sums (delta ones get it too, after a
 * delta→cumulative conversion the agent does not want to rely on) —
 * so the agent's contract is the stricter "monotonic AND cumulative",
 * and any violation here would silently miss every `_total` query.
 */
export function nonMonotonicSumNames(captures: OtlpCapture[]): string[] {
  const bad = new Set<string>();
  for (const m of capturedMetrics(captures)) {
    const sum = m.sum;
    if (sum && !(sum.aggregationTemporality === 2 && sum.isMonotonic === true)) {
      bad.add(typeof m.name === "string" ? m.name : "?");
    }
  }
  return [...bad];
}

/** All hook results must be 2xx; returns the offending result or null. */
export function firstBadResult(results: HookResult[]): HookResult | null {
  return results.find((r) => r.status < 200 || r.status >= 300) ?? null;
}
