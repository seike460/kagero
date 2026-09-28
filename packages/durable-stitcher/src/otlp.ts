/**
 * OTLP/HTTP exporter for stitched traces and derived metrics.
 * LGTM: plain POST. CloudWatch: SigV4-signed POST, with the service per
 * signal as in the collector template — traces "xray", metrics
 * "monitoring" (overridable per signal). The endpoint is always
 * injected — no backend URL is hardcoded here.
 */

import {
  ATTR_KAGERO_DURABLE_STATUS,
  METRIC_KAGERO_DURABLE_EXECUTION_DURATION_SECONDS,
  METRIC_KAGERO_DURABLE_EXECUTIONS,
  METRIC_KAGERO_DURABLE_REPLAYS,
} from "@kagero/semconv";
import type { ExecutionRecord } from "./model.js";
import { canonicalQuery, credsFromEnv, signRequest } from "./sigv4.js";
import { type AssembledTrace, durationSeconds, replayCount } from "./stitch.js";

export interface OtlpTarget {
  /** Base endpoint, e.g. "https://otlp.example.com" (no path). */
  endpoint: string;
  /**
   * Per-signal endpoint overrides. CloudWatch OTLP endpoints differ per
   * signal (xray.<region> for traces, monitoring.<region> for metrics,
   * logs.<region> for logs — AWS OTLP endpoints doc); a single base
   * cannot reach all three.
   */
  endpointTraces?: string;
  endpointMetrics?: string;
  backend: "lgtm" | "cloudwatch";
  /** Extra headers (LGTM basic auth token etc). */
  headers?: Record<string, string>;
  /** Region for SigV4 (required on cloudwatch). */
  region?: string;
  /** SigV4 service override applied to every signal. */
  sigv4Service?: string;
  /** Per-signal SigV4 services — defaults xray/monitoring on cloudwatch. */
  sigv4ServiceTraces?: string;
  sigv4ServiceMetrics?: string;
  timeoutMs?: number;
}

export interface Send {
  post(url: string, body: Buffer, headers: Record<string, string>): Promise<void>;
}

/** Injectable transport — tests inject a mock, production uses fetch. */
export function httpSend(timeoutMs = 5000): Send {
  return {
    async post(url, body, headers) {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`OTLP POST ${url} → ${res.status}: ${text.slice(0, 200)}`);
      }
    },
  };
}

type Signal = "traces" | "metrics";

/** SigV4 service name for a CloudWatch OTLP signal (AWS OTLP endpoints
 * doc): traces → xray, metrics → monitoring. Per-signal overrides win
 * over the global `sigv4Service` — a global default must not swallow a
 * signal-specific choice. */
function sigv4ServiceFor(target: OtlpTarget, signal: Signal): string {
  return (
    (signal === "traces" ? target.sigv4ServiceTraces : target.sigv4ServiceMetrics) ??
    target.sigv4Service ??
    (signal === "traces" ? "xray" : "monitoring")
  );
}

function signalBase(target: OtlpTarget, signal: Signal): string {
  const base =
    signal === "traces"
      ? (target.endpointTraces ?? target.endpoint)
      : (target.endpointMetrics ?? target.endpoint);
  return base.replace(/\/+$/, "");
}

function headersFor(
  target: OtlpTarget,
  url: string,
  body: Buffer,
  signal: Signal,
): Record<string, string> {
  const base = { "content-type": "application/json", ...target.headers };
  if (target.backend !== "cloudwatch") return base;
  const creds = credsFromEnv();
  if (!creds) throw new Error("cloudwatch backend needs AWS credentials in the environment");
  if (!target.region) throw new Error("cloudwatch backend needs a region for SigV4");
  // Sign the path the request actually takes — an endpoint may carry a
  // prefix path (e.g. behind a proxy) and/or query. The query must be
  // canonicalized (RFC3986-encoded, sorted) or the signature mismatches.
  const u = new URL(url);
  return signRequest(
    {
      method: "POST",
      host: u.host,
      path: u.pathname,
      query: u.search ? canonicalQuery(u.search.slice(1)) : "",
      headers: base,
      body,
    },
    creds,
    target.region,
    sigv4ServiceFor(target, signal),
  );
}

/** OTLP/JSON resourceSpans payload for an assembled trace. */
export function tracesPayload(
  trace: AssembledTrace,
  serviceName = "kagero-durable-stitcher",
): unknown {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: serviceName } },
            { key: "telemetry.sdk.language", value: { stringValue: "nodejs" } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "kagero-durable-stitcher" },
            spans: trace.spans.map((s) => {
              const o: Record<string, unknown> = {
                traceId: s.traceId,
                spanId: s.spanId,
                name: s.name,
                kind: s.kind,
                startTimeUnixNano: s.startTimeUnixNano,
                attributes: s.attributes,
                status: s.status,
              };
              if (s.parentSpanId) o.parentSpanId = s.parentSpanId;
              if (s.endTimeUnixNano) o.endTimeUnixNano = s.endTimeUnixNano;
              if (s.links?.length) o.links = s.links;
              return o;
            }),
          },
        ],
      },
    ],
  };
}

const DURABLE_BOUNDS = [1, 5, 10, 30, 60, 300, 600, 1800, 3600];

/**
 * Derived metrics payload (design §2-3: replay count + duration to
 * Mimir). Metric labels are restricted to allowed enum values only —
 * execution identity stays on spans, never on series (ADR-008).
 *
 * Temporality is DELTA (1), not cumulative: this Lambda runs after the
 * fact and is stateless across executions, so it cannot maintain running
 * totals — a cumulative series reporting `asInt: 1` per record would be
 * flat forever (increase() = 0) and a cumulative `replays` would report
 * only the CURRENT execution's count, under-counting everywhere.
 * Delta lets the backend accumulate correctly (Prometheus OTLP ingest
 * converts delta→cumulative and applies `_total`).
 *
 * The delta WINDOW is the execution's own [startTime, endTime] — not
 * [startTime, now]. OTel requires non-overlapping delta windows per
 * series; running to "now" would overlap the windows of concurrent
 * same-status executions. An execution window can still overlap a
 * *different* execution's window (durable runs do overlap); that edge is
 * bounded by Prometheus' delta→cumulative tolerance and is PoC-05 data.
 */
export function metricsPayload(
  rec: ExecutionRecord,
  serviceName = "kagero-durable-stitcher",
): unknown {
  const start = `${BigInt(rec.startTime.getTime()) * 1_000_000n}`;
  // Fall back to now only when the record somehow lacks endTime.
  const end = `${BigInt((rec.endTime ?? new Date()).getTime()) * 1_000_000n}`;
  const secs = durationSeconds(rec);
  const replays = replayCount(rec);

  // Per-bucket counts — OTLP requires sum(bucketCounts) == count.
  const bucketCounts: string[] = new Array(DURABLE_BOUNDS.length + 1).fill("0");
  const idx = DURABLE_BOUNDS.findIndex((b) => secs <= b);
  bucketCounts[idx === -1 ? DURABLE_BOUNDS.length : idx] = "1";

  const statusAttr = {
    key: ATTR_KAGERO_DURABLE_STATUS,
    value: { stringValue: rec.status },
  };

  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: serviceName } }],
        },
        scopeMetrics: [
          {
            scope: { name: "kagero-durable-stitcher" },
            metrics: [
              {
                name: METRIC_KAGERO_DURABLE_EXECUTIONS,
                sum: {
                  aggregationTemporality: 1,
                  isMonotonic: true,
                  dataPoints: [
                    {
                      startTimeUnixNano: start,
                      timeUnixNano: end,
                      asInt: "1",
                      attributes: [statusAttr],
                    },
                  ],
                },
              },
              {
                name: METRIC_KAGERO_DURABLE_REPLAYS,
                sum: {
                  aggregationTemporality: 1,
                  isMonotonic: true,
                  dataPoints: [
                    { startTimeUnixNano: start, timeUnixNano: end, asInt: String(replays) },
                  ],
                },
              },
              {
                name: METRIC_KAGERO_DURABLE_EXECUTION_DURATION_SECONDS,
                histogram: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    {
                      startTimeUnixNano: start,
                      timeUnixNano: end,
                      count: "1",
                      sum: secs,
                      bucketCounts,
                      explicitBounds: DURABLE_BOUNDS,
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Send a trace + its derived metrics. Failures throw — caller decides. */
export async function exportRecord(
  trace: AssembledTrace,
  rec: ExecutionRecord,
  target: OtlpTarget,
  send?: Send,
): Promise<void> {
  const s = send ?? httpSend(target.timeoutMs ?? 5000);
  const traces = Buffer.from(JSON.stringify(tracesPayload(trace)), "utf8");
  const metrics = Buffer.from(JSON.stringify(metricsPayload(rec)), "utf8");
  const traceUrl = `${signalBase(target, "traces")}/v1/traces`;
  await s.post(traceUrl, traces, headersFor(target, traceUrl, traces, "traces"));
  const metricUrl = `${signalBase(target, "metrics")}/v1/metrics`;
  await s.post(metricUrl, metrics, headersFor(target, metricUrl, metrics, "metrics"));
}
