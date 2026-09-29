/**
 * k6-runner — distributed k6 execution for Lambda shards (Step
 * Functions Distributed Map) and MicroVM workers (functions-durable-k6.md
 * §3). The launcher's only job is to give every shard the same
 * {scriptPath, runId, startAtMs, output} and a different shardIndex.
 *
 * Known v1 divergence: run coordinates are `run_id`/`shard_id` k6 tags
 * on the OTLP path but `kagero.k6.run.id`/`kagero.k6.shard.id` EMF
 * dimensions on the CloudWatch path — PoC-10 checks whether dotted tag
 * names work in k6 so both paths can use the semconv names.
 * Lambda workers must keep the TEXT log format — JSON log format wraps
 * stdout lines and CloudWatch stops recognising EMF.
 */

export * from "./annotations.js";
export * from "./emf.js";
export * from "./runner.js";
export * from "./schedule.js";
export * from "./shard.js";

import { resolveSecretArns } from "@kagero/secrets";
import { type OutputConfig, type RunShardInput, type RunShardResult, runShard } from "./runner.js";

/** The item a Distributed Map delivers to each worker Lambda. */
export interface ShardEvent {
  scriptPath: string;
  runId: string;
  shardIndex: number;
  shardCount: number;
  startAtMs: number;
  /** Backend selector; env supplies the concrete endpoint. */
  backend: "lgtm" | "cloudwatch" | "collector";
  k6Bin?: string;
  extraArgs?: string[];
  extraTags?: Record<string, string>;
  /** Region annotation, when KAGERO_GRAFANA_URL+TOKEN are set. */
  annotate?: boolean;
}

/**
 * Output wiring driven by env, per §3-3:
 * - lgtm: OTLP straight to the backend endpoint.
 * - cloudwatch: json → EMF on stdout (k6 cannot SigV4).
 * - collector (MicroVM): OTLP to the in-MicroVM collector — it owns
 *   identity stamping and the SigV4 hop, so shards never see a CW
 *   endpoint or credentials.
 *
 *   env                         | backend    | value
 *   ----------------------------|------------|------------------------------
 *   KAGERO_OTLP_ENDPOINT        | lgtm       | required; host:port, no scheme
 *   KAGERO_OTLP_EXPORTER_TYPE   | lgtm       | "grpc", else http/protobuf
 *   KAGERO_OTLP_HTTP_URL_PATH   | lgtm       | http only; default /v1/metrics
 *   KAGERO_OTLP_HEADERS         | lgtm       | "k1=v1,k2=v2"
 *   KAGERO_OTLP_USERNAME        | lgtm       | http basic auth user
 *   KAGERO_OTLP_PASSWORD        | lgtm       | http basic auth password
 *   KAGERO_OTLP_INSECURE        | lgtm       | "true" turns TLS off
 *   KAGERO_K6_METRIC_PREFIX     | lgtm       | K6_OTEL_METRIC_PREFIX
 *   KAGERO_K6_EMF_NAMESPACE     | cloudwatch | default "kagero/k6"
 *   KAGERO_COLLECTOR_OTLP       | collector  | default "127.0.0.1:4317"
 *
 * The endpoint and header values are k6's K6_OTEL_* formats. The agent
 * and the durable stitcher take a URL under KAGERO_OTLP_ENDPOINT, and
 * the stitcher reads KAGERO_OTLP_HEADER as "Name: value; ..." — a value
 * copied from either one does not work here.
 */
export function outputFromEnv(event: ShardEvent, env: NodeJS.ProcessEnv): OutputConfig {
  switch (event.backend) {
    case "cloudwatch":
      return { kind: "emf", namespace: env.KAGERO_K6_EMF_NAMESPACE ?? "kagero/k6" };
    case "collector":
      return {
        kind: "otlp",
        exporterType: "grpc",
        endpoint: env.KAGERO_COLLECTOR_OTLP ?? "127.0.0.1:4317",
        insecure: true,
      };
    case "lgtm": {
      const endpoint = env.KAGERO_OTLP_ENDPOINT;
      if (!endpoint) throw new Error("KAGERO_OTLP_ENDPOINT is required for lgtm backend");
      // headers carries the write-scoped backend credential —
      // "k1=v1,k2=v2" for K6_OTEL_HEADERS (Grafana Cloud OTLP token,
      // Mimir X-Scope-OrgID). Basic-auth pair works for http exporters.
      return {
        kind: "otlp",
        exporterType: env.KAGERO_OTLP_EXPORTER_TYPE === "grpc" ? "grpc" : "http",
        endpoint,
        urlPath: env.KAGERO_OTLP_HTTP_URL_PATH,
        metricPrefix: env.KAGERO_K6_METRIC_PREFIX,
        headers: env.KAGERO_OTLP_HEADERS,
        username: env.KAGERO_OTLP_USERNAME,
        password: env.KAGERO_OTLP_PASSWORD,
        insecure: env.KAGERO_OTLP_INSECURE === "true" ? true : undefined,
      };
    }
    default:
      throw new Error(
        `ShardEvent.backend must be lgtm|cloudwatch|collector, got ${JSON.stringify(
          event.backend,
        )}`,
      );
  }
}

/**
 * The GrafanaAnnotations.endpoint shape. "/api/annotations" is appended
 * as text, so a query or fragment would come before it, fetch refuses
 * userinfo, and whitespace that the URL parser trims from the value
 * alone breaks the joined URL. The authority ends at / \ ? # as in the
 * WHATWG parser; an "@" in it is userinfo, even an empty one.
 */
function isGrafanaBaseUrl(v: string): boolean {
  const scheme = /^https?:\/\//i.exec(v);
  const authority = scheme ? (v.slice(scheme[0].length).split(/[/\\?#]/, 1)[0] ?? "") : "";
  if (authority === "" || authority.includes("@") || /[?#\s\p{Cc}]/u.test(v)) return false;
  try {
    return new URL(v).hostname !== "";
  } catch {
    return false;
  }
}

/** Distributed Map worker handler — event per shard. KAGERO_GRAFANA_URL
 *  and KAGERO_GRAFANA_TOKEN enable the run's region annotation. A
 *  KAGERO_GRAFANA_URL of the wrong shape is a deployment error: it fails
 *  the worker here, before k6 starts, with an error that names the
 *  variable but not its value. A failed annotation POST still only
 *  warns. */
export function handlerFromEnv(env: NodeJS.ProcessEnv = process.env) {
  if (env.KAGERO_GRAFANA_URL && !isGrafanaBaseUrl(env.KAGERO_GRAFANA_URL)) {
    throw new Error(
      "KAGERO_GRAFANA_URL must be an absolute http:// or https:// URL with a host, " +
        "and no query, fragment, userinfo or whitespace",
    );
  }
  return async (event: ShardEvent): Promise<RunShardResult> => {
    const input: RunShardInput = {
      scriptPath: event.scriptPath,
      runId: event.runId,
      shardIndex: event.shardIndex,
      shardCount: event.shardCount,
      startAtMs: event.startAtMs,
      output: outputFromEnv(event, env),
      extraTags: event.extraTags,
    };
    if (event.k6Bin) input.k6Bin = event.k6Bin;
    if (event.extraArgs) input.extraArgs = event.extraArgs;
    // One region annotation per RUN — shard 0 posts it, or every shard
    // would publish N identical annotations.
    if (
      event.annotate &&
      event.shardIndex === 0 &&
      env.KAGERO_GRAFANA_URL &&
      env.KAGERO_GRAFANA_TOKEN
    ) {
      input.grafana = { endpoint: env.KAGERO_GRAFANA_URL, token: env.KAGERO_GRAFANA_TOKEN };
    }
    return runShard(input);
  };
}

/**
 * Deployment entry — lazy so importing the package is env-free.
 * KAGERO_*_SECRET_ARN vars (grafana token, OTLP password/headers) are
 * resolved via Secrets Manager once per execution environment
 * (ADR-011).
 */
let lazyHandler: Promise<(event: ShardEvent) => Promise<RunShardResult>> | undefined;
export const handler = async (event: ShardEvent): Promise<RunShardResult> => {
  // Reset on failure — caching a rejected init would poison the warm env.
  lazyHandler ??= resolveSecretArns(process.env)
    .then((env) => handlerFromEnv(env))
    .catch((err: unknown) => {
      lazyHandler = undefined;
      throw err;
    });
  return (await lazyHandler)(event);
};
