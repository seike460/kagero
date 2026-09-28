/**
 * Shard runner: wait for the shared start time, then run k6 as a
 * separate program (§3-4 — k6 is invoked, never linked; kagero stays
 * Apache-2.0). Output routing per §3-3:
 *
 *   backend     | Lambda shard              | MicroVM shard
 *   ------------|---------------------------|---------------------------
 *   LGTM        | -o opentelemetry direct   | -o opentelemetry → local
 *               |                           |   collector on the MicroVM
 *   CloudWatch  | -o json → EMF to stdout   | -o opentelemetry → local
 *               |   (k6 cannot SigV4)       |   collector → SigV4 exporter
 *
 * Env names are the documented K6_OTEL_* variables — the same variables
 * for grpc/http exporters, exporter type selects which applies.
 */

import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { METRIC_LABEL_FORBIDDEN } from "@kagero/semconv";
import { type FetchLike, type GrafanaAnnotations, postRunAnnotation } from "./annotations.js";
import { EmfEncoder } from "./emf.js";
import { type ClockDeps, systemClock, waitForStart } from "./schedule.js";
import { shardSpec } from "./shard.js";

export type OutputConfig =
  | {
      /** `-o opentelemetry` (k6 ≥ 0.53; older builds use the
       *  experimental-opentelemetry name — PoC-10 records the version). */
      kind: "otlp";
      /**
       * K6_OTEL_EXPORTER_PROTOCOL value (k6 ≥ 1.4 / v2): "grpc" or
       * "http/protobuf". The older K6_OTEL_EXPORTER_TYPE name was
       * removed in k6 v2 — do not emit it.
       */
      exporterType: "grpc" | "http";
      /** host:port, no scheme — the K6_OTEL_*_EXPORTER_ENDPOINT shape. */
      endpoint: string;
      insecure?: boolean;
      /** http exporter only; default /v1/metrics. */
      urlPath?: string;
      metricPrefix?: string;
      /**
       * Extra exporter headers, "k1=v1,k2=v2" — carries the backend's
       * write-scoped credential (e.g. Grafana Cloud OTLP token or a
       * Mimir X-Scope-OrgID). From deploy-time config only, never
       * logged (ADR-011).
       */
      headers?: string;
      /** http exporter basic auth (K6_OTEL_HTTP_EXPORTER_USERNAME/_PASSWORD). */
      username?: string;
      password?: string;
    }
  | {
      /** `-o json` → EMF on stdout (CloudWatch on Lambda shards). */
      kind: "emf";
      namespace?: string;
    }
  | {
      /** `-o json=path` verbatim — debugging / offline inspection. */
      kind: "json-file";
      path: string;
    };

export interface RunShardInput {
  /** Path to the k6 script inside the worker. */
  scriptPath: string;
  runId: string;
  shardIndex: number;
  shardCount: number;
  /** Shared start time, epoch ms. */
  startAtMs: number;
  output: OutputConfig;
  /** k6 binary name/path (default "k6"). */
  k6Bin?: string;
  /** Extra `k6 run` args (e.g. "--paused" is NOT used — the shard waits
   *  by clock, then runs immediately, per §3-2). */
  extraArgs?: string[];
  /** Extra `--tag key=value` pairs merged into every k6 metric. */
  extraTags?: Record<string, string>;
  /** Forward-schedule bound for waitForStart. */
  maxWaitMs?: number;
  /** Temp path for the json file in emf mode (default /tmp/k6-out.json). */
  jsonOutPath?: string;
  /** When set, a start→end region annotation is posted. */
  grafana?: GrafanaAnnotations;
}

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SpawnLike = (
  cmd: string,
  args: string[],
  env: Record<string, string | undefined>,
) => Promise<SpawnResult>;

export interface RunShardDeps {
  spawn?: SpawnLike;
  clock?: ClockDeps;
  /** EMF sink — default stdout (Lambda stdout → CloudWatch Logs). */
  emit?: (line: string) => void;
  fetchImpl?: FetchLike;
  /** Line source for the k6 json output — default streams the file;
   *  it can reach GBs on long shards and must not sit whole in memory. */
  readLinesFn?: (path: string) => AsyncIterable<string>;
}

export interface RunShardResult {
  exitCode: number;
  /** Actual start minus scheduled start (MVP target: ≤ 2000 ms). */
  skewMs: number;
  shard: { index: number; count: number };
  /** EMF lines emitted in emf mode (0 elsewhere). */
  emfLines: number;
  /** Unparseable k6 json lines in emf mode. */
  emfSkipped: number;
}

const DEFAULT_JSON_OUT_PATH = "/tmp/k6-out.json";

/** Default line source for the EMF path — streams the k6 json output
 *  one line at a time (the file scales with point count and can reach
 *  GBs; it must never sit whole in memory). */
async function* readJsonLines(path: string): AsyncIterable<string> {
  const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) yield line;
}

/** Build `k6 run` args for a shard — pure, for tests and review. */
export function k6Args(input: RunShardInput): string[] {
  const spec = shardSpec(input.shardIndex, input.shardCount);
  const args = [
    "run",
    "--execution-segment",
    spec.segment,
    "--execution-segment-sequence",
    spec.sequence,
  ];
  const tags: [string, string][] = [
    ["run_id", input.runId],
    ["shard_id", String(input.shardIndex)],
  ];
  // k6 --tag values become metric attributes on the OTLP path — reject
  // forbidden-id names so an extra tag cannot smuggle ADR-008 IDs back
  // in (the collector still strips, but refuse at the source too).
  for (const [k, v] of Object.entries(input.extraTags ?? {})) {
    if (isForbiddenTagKey(k)) {
      throw new Error(`extraTags key "${k}" collides with a forbidden metric label`);
    }
    if (k === "run_id" || k === "shard_id") {
      throw new Error(`extraTags key "${k}" would silently override the run coordinate`);
    }
    tags.push([k, v]);
  }
  for (const [k, v] of tags) args.push("--tag", `${k}=${v}`);
  switch (input.output.kind) {
    case "otlp":
      args.push("-o", "opentelemetry");
      break;
    case "emf":
      args.push("--out", `json=${input.jsonOutPath ?? DEFAULT_JSON_OUT_PATH}`);
      break;
    case "json-file":
      args.push("--out", `json=${input.output.path}`);
      break;
  }
  args.push(...(input.extraArgs ?? []), input.scriptPath);
  return args;
}

const FORBIDDEN_TAG_NAMES = new Set([
  ...METRIC_LABEL_FORBIDDEN,
  // Semconv names are dotted; k6 tags are usually written snake_case —
  // block both spellings plus the last two segments ("tenant_id").
  ...METRIC_LABEL_FORBIDDEN.map((k) => k.replaceAll(".", "_")),
  ...METRIC_LABEL_FORBIDDEN.map((k) => k.split(".").slice(-2).join("_")),
]);

function isForbiddenTagKey(k: string): boolean {
  return FORBIDDEN_TAG_NAMES.has(k);
}

/** K6_OTEL_* env for the otlp output (documented variable names). */
export function k6OtelEnv(output: Extract<OutputConfig, { kind: "otlp" }>): Record<string, string> {
  // K6_OTEL_EXPORTER_PROTOCOL — valid values are "grpc" | "http/protobuf"
  // (K6_OTEL_EXPORTER_TYPE was removed in k6 v2).
  const env: Record<string, string> = {
    K6_OTEL_EXPORTER_PROTOCOL: output.exporterType === "grpc" ? "grpc" : "http/protobuf",
  };
  if (output.exporterType === "grpc") {
    env.K6_OTEL_GRPC_EXPORTER_ENDPOINT = output.endpoint;
    if (output.insecure) env.K6_OTEL_GRPC_EXPORTER_INSECURE = "true";
  } else {
    env.K6_OTEL_HTTP_EXPORTER_ENDPOINT = output.endpoint;
    if (output.insecure) env.K6_OTEL_HTTP_EXPORTER_INSECURE = "true";
    if (output.urlPath) env.K6_OTEL_HTTP_EXPORTER_URL_PATH = output.urlPath;
    if (output.username) env.K6_OTEL_HTTP_EXPORTER_USERNAME = output.username;
    if (output.password) env.K6_OTEL_HTTP_EXPORTER_PASSWORD = output.password;
  }
  if (output.metricPrefix) env.K6_OTEL_METRIC_PREFIX = output.metricPrefix;
  if (output.headers) env.K6_OTEL_HEADERS = output.headers;
  return env;
}

async function defaultSpawn(
  cmd: string,
  args: string[],
  env: Record<string, string | undefined>,
): Promise<SpawnResult> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env } });
    // Keep a bounded tail — a long run must not grow memory without
    // limit, and on failure the tail is the useful context.
    const tail = (acc: string, d: Buffer) => (acc + d.toString()).slice(-64 * 1024);
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => {
      stdout = tail(stdout, d);
    });
    p.stderr.on("data", (d: Buffer) => {
      stderr = tail(stderr, d);
    });
    p.on("error", reject);
    p.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * One shard: wait for the shared start → run k6 → convert/stream
 * results → annotate. k6's exit code propagates (threshold failures
 * must stay visible to the orchestrator).
 */
export async function runShard(
  input: RunShardInput,
  deps: RunShardDeps = {},
): Promise<RunShardResult> {
  // Validate everything that can fail BEFORE waiting for the start —
  // a bad config must not burn the wait window or the k6 run.
  const args = k6Args(input);
  if (input.output.kind === "emf" && input.output.namespace?.startsWith("AWS/")) {
    throw new Error("EMF namespace must not start with 'AWS/'");
  }
  const jsonOutPath = input.jsonOutPath ?? DEFAULT_JSON_OUT_PATH;
  // /tmp outlives the invocation in a warm execution environment, and a
  // k6 that dies before initialising its output leaves the file as it
  // was — the previous shard's points would go out under this run's ids.
  if (input.output.kind === "emf") await rm(jsonOutPath, { force: true });

  const clock = deps.clock ?? systemClock;
  const { skewMs } = await waitForStart(input.startAtMs, clock, input.maxWaitMs);
  const startedMs = clock.now();

  const env: Record<string, string | undefined> =
    input.output.kind === "otlp" ? k6OtelEnv(input.output) : {};
  const spawn = deps.spawn ?? defaultSpawn;
  const res = await spawn(input.k6Bin ?? "k6", args, env);
  const finishedMs = clock.now();

  if (res.code !== 0 && res.stderr) {
    console.warn(`k6 exited ${res.code}: ${res.stderr.slice(-2000)}`);
  }

  let emfLines = 0;
  let emfSkipped = 0;
  if (input.output.kind === "emf") {
    const readLines = deps.readLinesFn ?? readJsonLines;
    const emit = deps.emit ?? ((l: string) => console.log(l));
    const enc = new EmfEncoder(
      { runId: input.runId, shardId: String(input.shardIndex) },
      input.output.namespace,
    );
    // k6 can die before initialising the output (compile/arg errors) —
    // a missing json file means zero points, not a shard failure; the
    // exit code still carries the real error. The guards wrap ONLY the
    // read step: an emit failure is a broken sink and must propagate
    // (drained-but-unemitted lines are already gone by then anyway).
    let lines: AsyncIterable<string> | undefined;
    try {
      lines = readLines(jsonOutPath);
    } catch {
      emfSkipped++;
    }
    if (lines) {
      const it = lines[Symbol.asyncIterator]();
      try {
        for (;;) {
          let next: IteratorResult<string>;
          try {
            next = await it.next();
          } catch {
            emfSkipped++;
            break;
          }
          if (next.done) break;
          enc.feed(next.value);
          // The encoder retires completed second-buckets as it goes —
          // drain them per line so pending output stays bounded too.
          for (const l of enc.drain()) {
            emit(l);
            emfLines++;
          }
        }
      } finally {
        await it.return?.();
      }
    }
    emfSkipped += enc.skipped;
    for (const l of enc.flush()) {
      emit(l);
      emfLines++;
    }
  }

  // postRunAnnotation is fire-and-warn — it never rejects.
  if (input.grafana) {
    await postRunAnnotation(
      input.grafana,
      {
        startMs: startedMs,
        endMs: finishedMs,
        runId: input.runId,
        shardCount: input.shardCount,
      },
      deps.fetchImpl,
    );
  }

  return {
    exitCode: res.code,
    skewMs,
    shard: { index: input.shardIndex, count: input.shardCount },
    emfLines,
    emfSkipped,
  };
}
