/**
 * k6 JSON output → CloudWatch EMF conversion (§3-3, CloudWatch column
 * for Lambda shards: k6's OTel output cannot SigV4, so metrics ride the
 * function's stdout as EMF).
 *
 * k6 `--out json=path` writes one JSON object per line (verified in the
 * k6 docs):
 *   {"type":"Metric","data":{"type":"trend","contains":"time",...},
 *    "metric":"http_req_duration"}
 *   {"type":"Point","data":{"time":"...","value":459.8,"tags":{...}},
 *    "metric":"http_req_duration"}
 *
 * EMF records (verified in the EMF spec):
 *   {"_aws":{"Timestamp":ms,"CloudWatchMetrics":[{"Namespace":ns,
 *     "Dimensions":[[keyA,keyB]],
 *     "Metrics":[{"Name":n,"Unit":u}]}]},
 *    "<n>":[v,...],"<keyA>":runId,"<keyB>":shardId}
 *
 * Design choices:
 * - Submetric points ("m{tag:v}") are DROPPED, never folded: k6 emits a
 *   submetric point for every sample that matches its tag selector AND
 *   the parent point as well, so folding double-counts.
 * - Per-point k6 tags (url, method, status) never become dimensions.
 * - Points batch into value arrays (EMF limit: 100 per metric), grouped
 *   per metric AND per second — a single Timestamp per record means
 *   collapsing the whole run into one instant would kill the time axis.
 * - The only dimensions are the run/shard coordinates.
 */

import { ATTR_KAGERO_K6_RUN_ID, ATTR_KAGERO_K6_SHARD_ID } from "@kagero/semconv";

export interface EmfDimensions {
  runId: string;
  shardId: string;
}

/** EMF hard limits from the spec. */
const MAX_VALUES = 100;
const MAX_DIM_VALUE = 1024;
/** Reserved root members — a metric of this name would corrupt a record. */
const RESERVED = new Set(["_aws", ATTR_KAGERO_K6_RUN_ID, ATTR_KAGERO_K6_SHARD_ID]);

type K6MetricType = "gauge" | "rate" | "counter" | "trend";

interface K6MetricMeta {
  type?: K6MetricType;
  contains?: string;
}

interface K6Line {
  type?: string;
  metric?: string;
  data?: Record<string, unknown> & { time?: string; value?: number };
}

function unitFor(meta: K6MetricMeta | undefined): string {
  // "contains" is verified k6 metadata: time → ms values, data → bytes.
  if (meta?.contains === "time") return "Milliseconds";
  if (meta?.contains === "data") return "Bytes";
  return "None";
}

/** True when the name is a submetric ("m{tag:v}") — dropped, not folded. */
export function isSubmetric(name: string): boolean {
  return name.includes("{");
}

/** Strip the {tag:...} submetric suffix — metadata folds into the parent. */
export function baseMetricName(name: string): string {
  const i = name.indexOf("{");
  return (i === -1 ? name : name.slice(0, i)).trim();
}

function dimValue(v: string): string {
  // EMF requires string dimension members, ≤1024 chars.
  return v.length > MAX_DIM_VALUE ? v.slice(0, MAX_DIM_VALUE) : v;
}

export class EmfEncoder {
  /** Lines skipped as unparseable/submetric — diagnostics only. */
  skipped = 0;
  private readonly metas = new Map<string, K6MetricMeta>();
  /** metric → second-bucket (ms) → points, bounded: a bucket is emitted
   *  as soon as it fills a MAX_VALUES chunk or ages out of the
   *  trailing-second window, so memory tracks the window — not the
   *  point count. */
  private readonly buckets = new Map<string, Map<number, number[]>>();
  /** EMF lines completed but not yet drained by the caller. */
  private readonly pending: string[] = [];
  /** Newest point second seen — gates bucket retirement. */
  private maxSecMs = 0;
  /** Timestamp for undated points (second-bucket 0) — fixed once so
   *  feed-time chunks and the final flush share one timestamp. */
  private readonly fallbackMs = Date.now();

  constructor(
    private readonly dims: EmfDimensions,
    private readonly namespace = "kagero/k6",
  ) {
    if (namespace.startsWith("AWS/")) {
      throw new Error("EMF namespace must not start with 'AWS/'");
    }
  }

  /** Consume one k6 json-output line. Unknown lines are skipped. */
  feed(line: string): void {
    const t = line.trim();
    if (!t) return;
    let obj: K6Line;
    try {
      obj = JSON.parse(t) as K6Line;
    } catch {
      this.skipped++;
      return;
    }
    if (obj.type === "Metric" && typeof obj.metric === "string") {
      const name = isSubmetric(obj.metric) ? baseMetricName(obj.metric) : obj.metric.trim();
      if (name) {
        this.metas.set(name, {
          type: obj.data?.type as K6MetricType | undefined,
          contains: typeof obj.data?.contains === "string" ? obj.data.contains : undefined,
        });
      }
      return;
    }
    if (
      obj.type === "Point" &&
      typeof obj.metric === "string" &&
      typeof obj.data?.value === "number"
    ) {
      // Submetric points duplicate a parent point — drop them.
      if (isSubmetric(obj.metric)) {
        this.skipped++;
        return;
      }
      const name = obj.metric.trim();
      if (!name || RESERVED.has(name)) {
        this.skipped++;
        return;
      }
      const ms = typeof obj.data.time === "string" ? Date.parse(obj.data.time) : Number.NaN;
      const secondMs = Number.isNaN(ms) ? 0 : Math.floor(ms / 1000) * 1000;
      let perMetric = this.buckets.get(name);
      if (!perMetric) {
        perMetric = new Map();
        this.buckets.set(name, perMetric);
      }
      const isNewBucket = !perMetric.has(secondMs);
      const vals = perMetric.get(secondMs) ?? [];
      vals.push(obj.data.value);
      perMetric.set(secondMs, vals);
      if (vals.length >= MAX_VALUES) {
        this.emitChunk(name, secondMs, vals.splice(0, MAX_VALUES));
      }
      // k6 streams points in wall-clock order — once a newer second is
      // seen, older buckets will not grow further; retire them now so
      // memory stays proportional to the trailing window, not to the
      // point count. Retire on every bucket creation too: a straggler
      // that reopens an out-of-window bucket is emitted and dropped at
      // once, or unordered input would grow the map unboundedly.
      const advanced = secondMs > this.maxSecMs;
      if (advanced) this.maxSecMs = secondMs;
      if (advanced || isNewBucket) {
        this.retireBefore(this.maxSecMs - 1000);
      }
      return;
    }
    this.skipped++;
  }

  /** Serialize one EMF record into `pending` (drained by the caller). */
  private emitChunk(name: string, secondMs: number, values: number[]) {
    const record = {
      _aws: {
        Timestamp: secondMs || this.fallbackMs,
        CloudWatchMetrics: [
          {
            Namespace: this.namespace,
            Dimensions: [[ATTR_KAGERO_K6_RUN_ID, ATTR_KAGERO_K6_SHARD_ID]],
            Metrics: [{ Name: name, Unit: unitFor(this.metas.get(name)) }],
          },
        ],
      },
      [name]: values.length === 1 ? values[0] : values,
      [ATTR_KAGERO_K6_RUN_ID]: dimValue(this.dims.runId),
      [ATTR_KAGERO_K6_SHARD_ID]: dimValue(this.dims.shardId),
    };
    this.pending.push(JSON.stringify(record));
  }

  /** Emit every bucket older than `thresholdMs` and drop it — including
   *  emptied post-chunk buckets, or they would accumulate forever. */
  private retireBefore(thresholdMs: number) {
    for (const [name, perMetric] of this.buckets) {
      for (const [sec, vals] of perMetric) {
        if (sec < thresholdMs) {
          if (vals.length > 0) this.emitChunk(name, sec, vals);
          perMetric.delete(sec);
        }
      }
    }
  }

  /** EMF lines completed so far — drain periodically during a long
   *  input stream so output memory stays bounded too. */
  drain(): string[] {
    return this.pending.splice(0);
  }

  /** Emit all buffered points as EMF log lines, chunking at 100 values. */
  flush(): string[] {
    for (const [name, perMetric] of this.buckets) {
      for (const [secondMs, values] of perMetric) {
        for (let i = 0; i < values.length; i += MAX_VALUES) {
          this.emitChunk(name, secondMs, values.slice(i, i + MAX_VALUES));
        }
      }
    }
    this.buckets.clear();
    return this.drain();
  }
}

/** Convenience: convert a whole k6 json output (text or lines) to EMF. */
export function k6JsonToEmf(
  input: string | readonly string[],
  dims: EmfDimensions,
  namespace?: string,
): { emfLines: string[]; skipped: number } {
  const enc = new EmfEncoder(dims, namespace);
  const lines: readonly string[] = typeof input === "string" ? input.split("\n") : input;
  for (const l of lines) enc.feed(l);
  return { emfLines: enc.flush(), skipped: enc.skipped };
}
