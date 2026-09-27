/**
 * Assertion helpers over the evidence the simulator collects: OTLP
 * captures and the app's hook-arrival log.
 */
import { METRIC_LABEL_FORBIDDEN } from "@kagero/semconv";
import type { HookResult } from "./hooks.js";
import type { OtlpCapture } from "./mock-otlp.js";

/** Every attribute key anywhere inside an OTLP metrics payload:
 * resource attributes, instrumentation-scope attributes, AND datapoint
 * attributes (all three can end up as labels). */
export function metricAttrKeys(payload: unknown): string[] {
  const keys: string[] = [];
  const attrs = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const a of list) {
      const key = (a as { key?: unknown })?.key;
      if (typeof key === "string") keys.push(key);
    }
  };
  const walkMetrics = (m: unknown) => {
    if (!Array.isArray(m)) return;
    for (const metric of m) {
      const data = (metric as Record<string, unknown>) ?? {};
      for (const kind of ["sum", "gauge", "histogram", "exponentialHistogram", "summary"]) {
        const pts = (data[kind] as { dataPoints?: unknown[] })?.dataPoints;
        if (Array.isArray(pts))
          for (const p of pts) attrs((p as { attributes?: unknown }).attributes);
      }
    }
  };
  const rms = (payload as { resourceMetrics?: unknown[] })?.resourceMetrics;
  if (Array.isArray(rms)) {
    for (const rm of rms) {
      attrs((rm as { resource?: { attributes?: unknown } })?.resource?.attributes);
      const scopes = (rm as { scopeMetrics?: unknown[] })?.scopeMetrics;
      if (Array.isArray(scopes))
        for (const s of scopes) {
          attrs((s as { scope?: { attributes?: unknown } })?.scope?.attributes);
          walkMetrics((s as { metrics?: unknown }).metrics);
        }
    }
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
  for (const c of captures) {
    if (c.path !== "/v1/metrics") continue;
    const rms = (c.body as { resourceMetrics?: unknown[] })?.resourceMetrics ?? [];
    for (const rm of rms) {
      const scopes = (rm as { scopeMetrics?: unknown[] })?.scopeMetrics ?? [];
      for (const s of scopes) {
        for (const m of (s as { metrics?: { name?: string }[] }).metrics ?? []) {
          if (m?.name) names.add(m.name);
        }
      }
    }
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
  const rms = (c.body as { resourceMetrics?: unknown[] })?.resourceMetrics ?? [];
  for (const rm of rms) {
    const scopes = (rm as { scopeMetrics?: unknown[] })?.scopeMetrics ?? [];
    for (const s of scopes) {
      const metrics = (s as { metrics?: unknown[] })?.metrics ?? [];
      for (const m of metrics) {
        const data = (m as Record<string, unknown>) ?? {};
        for (const kind of ["sum", "gauge", "histogram", "exponentialHistogram", "summary"]) {
          const pts = (data[kind] as { dataPoints?: unknown[] })?.dataPoints ?? [];
          for (const p of pts) {
            const attrs =
              (p as { attributes?: { key?: string; value?: { stringValue?: string } }[] })
                ?.attributes ?? [];
            for (const a of attrs) {
              if (a.key === "kagero.lifecycle.event" && a.value?.stringValue === event) {
                return true;
              }
            }
          }
        }
      }
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
  for (const c of captures) {
    if (c.path !== "/v1/metrics") continue;
    const rms = (c.body as { resourceMetrics?: unknown[] })?.resourceMetrics ?? [];
    for (const rm of rms) {
      const scopes = (rm as { scopeMetrics?: unknown[] })?.scopeMetrics ?? [];
      for (const s of scopes) {
        for (const m of (s as { metrics?: { name?: string; sum?: unknown }[] }).metrics ?? []) {
          const sum = m?.sum as
            | { aggregationTemporality?: number; isMonotonic?: boolean }
            | undefined;
          if (sum && !(sum.aggregationTemporality === 2 && sum.isMonotonic === true)) {
            bad.add(m.name ?? "?");
          }
        }
      }
    }
  }
  return [...bad];
}

/** All hook results must be 2xx; returns the offending result or null. */
export function firstBadResult(results: HookResult[]): HookResult | null {
  return results.find((r) => r.status < 200 || r.status >= 300) ?? null;
}
