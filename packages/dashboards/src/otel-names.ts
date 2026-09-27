/**
 * OTel metric/label names → backend selector spellings (architecture.md
 * §7 "OTel の名前から PromQL のセレクタへの変換（例外表つき）").
 * Both backends speak PromQL here — LGTM stores OTel metrics in Mimir
 * (dots become underscores) and CloudWatch exposes OTLP metrics through
 * its PromQL endpoint. A per-backend EXCEPTIONS map covers the cases
 * where a backend diverges (PoC-06 verifies CloudWatch's spelling).
 */
import { KAGERO_METRICS, METRIC_LABEL_FORBIDDEN } from "@kagero/semconv";

/** Default OTel→Prometheus translation: every non [a-zA-Z0-9_:] → "_". */
export function promName(otel: string): string {
  return otel.replace(/[^a-zA-Z0-9_:]/g, "_");
}

/**
 * Prometheus OTLP ingest defaults to `UnderscoreEscapingWithSuffixes`,
 * which appends `_total` to monotonic Sum series (OTel spec:
 * "compatibility/prometheus_and_openmetrics"). Registry counters therefore
 * exist under `*_total` spellings in Mimir — and in CloudWatch's OTLP→
 * PromQL surface as far as verified (PoC-06 confirms the exact spelling).
 *
 * Unit suffixes need no exception: every kagero metric whose unit maps to
 * a suffix (`s` → `_seconds`, `{vcpu}s`/`{gib}s` → `_seconds`) already
 * ends with that suffix, so the translator dedupes it. Histograms' type
 * suffix (`_bucket`/`_count`/`_sum`) is appended by the query, not here.
 */
export const OTLP_TOTAL_EXCEPTIONS: Record<string, string> = Object.fromEntries(
  Object.entries(KAGERO_METRICS)
    .filter(([, m]) => m.instrument === "counter")
    .map(([name]) => [name, `${promName(name)}_total`]),
);

export type MetricNamer = (otelName: string) => string;

/** Build a namer with per-backend spelling exceptions. */
export function makeNamer(exceptions: Record<string, string> = {}): MetricNamer {
  return (otel) => assertSafeSelector(exceptions[otel] ?? promName(otel));
}

/**
 * ADR-008 guard: reject a selector that mentions a forbidden metric
 * label in EITHER dotted-OTel or translated spelling. A forbidden key
 * in PromQL position would always be a label usage — fail loud so a
 * high-cardinality id can never reach a dashboard.
 */
export function assertSafeSelector<T extends string>(expr: T): T {
  for (const key of METRIC_LABEL_FORBIDDEN) {
    const prom = promName(key);
    for (const k of new Set([key, prom])) {
      if (expr.includes(k)) {
        throw new Error(`forbidden metric label "${key}" appears in selector: ${expr}`);
      }
    }
  }
  return expr;
}
