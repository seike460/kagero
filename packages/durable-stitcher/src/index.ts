/**
 * Stitcher pipeline: EventBridge completion → history → trace+metrics →
 * backend (functions-durable-k6.md §2). Post-completion assembly only —
 * no in-progress streaming (MVP scope §2-4).
 */

export * from "./events.js";
export * from "./fetcher.js";
export * from "./model.js";
export * from "./otlp.js";
export * from "./sigv4.js";
export * from "./stitch.js";

import { resolveSecretArns } from "@kagero/secrets";
import { parseEventBridge } from "./events.js";
import { type HistoryFetcher, lambdaApiFetcher } from "./fetcher.js";
import { toDate } from "./model.js";
import { exportRecord, type OtlpTarget, type Send } from "./otlp.js";
import { assembleTrace } from "./stitch.js";

export interface StitchDeps {
  fetcher: HistoryFetcher;
  /** One or more OTLP targets (KAGERO_BACKEND=both exports to both). */
  targets: OtlpTarget[];
  /** Injectable transport — tests pass a mock; real runs use fetch. */
  send?: Send;
  /** Injectable sleep for the consistency retry (default setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Wait before re-fetching when the history lags the notification. */
  retryDelayMs?: number;
}

export interface StitchResult {
  executionArn: string;
  status: string;
  /** true when nothing was exported (non-terminal notification). */
  skipped: boolean;
  reason?: string;
  traceId?: string;
  spanCount?: number;
}

const TERMINAL: ReadonlySet<string> = new Set(["succeeded", "failed", "timed_out", "stopped"]);

/** One notification → assembled trace + metrics, exported. */
export async function stitchNotification(
  rawEvent: unknown,
  deps: StitchDeps,
): Promise<StitchResult> {
  const note = parseEventBridge(rawEvent);

  // §2-2 "実行の完了の通知を受けて" — RUNNING (and any future
  // non-terminal) notifications are skipped, or executions{status=
  // running} would double-count once the terminal event lands.
  if (!TERMINAL.has(note.status)) {
    return {
      executionArn: note.executionArn,
      status: note.status,
      skipped: true,
      reason: `non-terminal status ${note.status}`,
    };
  }

  let rec = await deps.fetcher.getHistory(note.executionArn);

  // EventBridge can win the race against history propagation: the
  // notification says terminal but the API still reports running.
  // Retry once after a short wait; if still running, trust the
  // notification (source of truth for terminal state) — otherwise the
  // trace would stay "running" forever and never be re-assembled.
  if (rec.status === "running") {
    const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    await sleep(deps.retryDelayMs ?? 2000);
    rec = await deps.fetcher.getHistory(note.executionArn);
    if (rec.status === "running") {
      rec = { ...rec, status: note.status };
      const end = toDate(note.endTimestamp);
      if (end) rec.endTime = end;
    }
  }
  // The notification's name is more reliable than the arn segment.
  if (note.name) rec = { ...rec, name: note.name };

  const trace = assembleTrace(rec);
  // Fan out to every configured target. ANY target failure throws so
  // EventBridge retries the notification — silently accepting a partial
  // failure would permanently lose the trace on that backend and break
  // the LGTM/CloudWatch parity promise (ADR-002). The retry cost is a
  // duplicate on the already-delivered side: spans are idempotent
  // (deterministic traceId) and delta metrics may double-count once,
  // which is the lesser evil next to losing data.
  const results = await Promise.allSettled(
    deps.targets.map((t) => exportRecord(trace, rec, t, deps.send)),
  );
  const failures = results
    .map((r, i) => ({ r, backend: deps.targets[i]?.backend }))
    .filter((x) => x.r.status === "rejected");
  if (failures.length > 0) {
    throw new Error(
      `export failed on ${failures.length}/${results.length} target(s): ` +
        failures
          .map((f) => `${f.backend}: ${f.r.status === "rejected" ? String(f.r.reason) : ""}`)
          .join("; "),
    );
  }
  return {
    executionArn: rec.executionArn,
    status: rec.status,
    skipped: false,
    traceId: trace.traceId,
    spanCount: trace.spans.length,
  };
}

/** Every setting whose value can become an OtlpTarget endpoint. */
const ENDPOINT_SETTINGS = [
  "KAGERO_OTLP_ENDPOINT",
  "KAGERO_OTLP_ENDPOINT_LGTM",
  "KAGERO_OTLP_ENDPOINT_CLOUDWATCH",
  "KAGERO_OTLP_ENDPOINT_CLOUDWATCH_TRACES",
  "KAGERO_OTLP_ENDPOINT_CLOUDWATCH_METRICS",
  "KAGERO_OTLP_ENDPOINT_CLOUDWATCH_LOGS",
] as const;

const BASE_URL_RULE =
  "must be an absolute http:// or https:// URL with a host, and no query, " +
  "fragment, userinfo or whitespace";

/**
 * The OtlpTarget.endpoint shape. "/v1/<signal>" is appended as text, so
 * a query or fragment would come before it, fetch refuses userinfo, and
 * whitespace that the URL parser trims from the value alone breaks the
 * joined URL. The authority ends at / \ ? # as in the WHATWG parser; an
 * "@" in it is userinfo, even an empty one ("https://@host").
 */
function isOtlpBaseUrl(v: string): boolean {
  const scheme = /^https?:\/\//i.exec(v);
  const authority = scheme ? (v.slice(scheme[0].length).split(/[/\\?#]/, 1)[0] ?? "") : "";
  if (authority === "" || authority.includes("@") || /[?#\s\p{Cc}]/u.test(v)) return false;
  try {
    return new URL(v).hostname !== "";
  } catch {
    return false;
  }
}

/**
 * Lambda handler shape — env-configured for real deployments. Every
 * endpoint setting that is set, and every endpoint derived from the
 * region, is checked here once against the OtlpTarget.endpoint shape;
 * the error names the setting but never its value, which may carry a
 * token.
 */
export function handlerFromEnv(env: NodeJS.ProcessEnv = process.env) {
  // Region env name matches the agent's KAGERO_AWS_REGION (config.rs).
  const region = env.KAGERO_AWS_REGION ?? env.AWS_REGION;
  const lgtmHeaders = env.KAGERO_OTLP_HEADER
    ? // "Name: value; Name2: value2" — never secrets in env beyond a token
      // the deployer explicitly chooses to place (same trust level as the
      // collector env templates, ADR-011 aware).
      Object.fromEntries(
        env.KAGERO_OTLP_HEADER.split(";").flatMap((h) => {
          const i = h.indexOf(":");
          return i > 0 ? [[h.slice(0, i).trim(), h.slice(i + 1).trim()]] : [];
        }),
      )
    : undefined;
  const mk = (endpoint: string | undefined, backend: OtlpTarget["backend"]): OtlpTarget => {
    const t: OtlpTarget = {
      endpoint: endpoint ?? "",
      backend,
      region,
      // CloudWatch authenticates with SigV4 only — the LGTM credential
      // must not reach AWS, and a second authorization header breaks the
      // signature.
      headers: backend === "lgtm" ? lgtmHeaders : undefined,
      sigv4Service: env.KAGERO_OTLP_SIGV4_SERVICE,
    };
    if (backend === "cloudwatch") {
      const cw = resolveCwEndpoints(env, region, endpoint);
      // The base `endpoint` slot carries the logs URL — the stitcher
      // posts only traces/metrics today, but signalBase() falls back to
      // it for a logs signal if one is ever added.
      t.endpoint = cw.logs;
      t.endpointTraces = cw.traces;
      t.endpointMetrics = cw.metrics;
      t.sigv4ServiceTraces = env.KAGERO_OTLP_SIGV4_SERVICE_TRACES;
      t.sigv4ServiceMetrics = env.KAGERO_OTLP_SIGV4_SERVICE_METRICS;
    }
    return t;
  };

  // "both" fans out to the two endpoints; single-backend deployments use
  // KAGERO_OTLP_ENDPOINT (which also serves as the CloudWatch shared
  // fallback in either mode).
  const targets: OtlpTarget[] = [];
  const backendEnv = env.KAGERO_BACKEND ?? "lgtm";
  if (!["lgtm", "cloudwatch", "both"].includes(backendEnv)) {
    throw new Error(
      `unknown KAGERO_BACKEND ${JSON.stringify(backendEnv)} — expected lgtm|cloudwatch|both`,
    );
  }
  // Fail at init, not on every export. Empty means unset.
  for (const key of ENDPOINT_SETTINGS) {
    const v = env[key];
    if (v && !isOtlpBaseUrl(v)) throw new Error(`${key} ${BASE_URL_RULE}`);
  }
  if (backendEnv === "both") {
    if (!env.KAGERO_OTLP_ENDPOINT_LGTM) {
      // CloudWatch side may derive from AWS_REGION; LGTM has no default.
      throw new Error("KAGERO_BACKEND=both requires KAGERO_OTLP_ENDPOINT_LGTM");
    }
    targets.push(mk(env.KAGERO_OTLP_ENDPOINT_LGTM, "lgtm"));
    targets.push(mk(env.KAGERO_OTLP_ENDPOINT_CLOUDWATCH ?? env.KAGERO_OTLP_ENDPOINT, "cloudwatch"));
  } else {
    const endpoint =
      backendEnv === "cloudwatch"
        ? (env.KAGERO_OTLP_ENDPOINT_CLOUDWATCH ?? env.KAGERO_OTLP_ENDPOINT)
        : env.KAGERO_OTLP_ENDPOINT;
    // LGTM has no derivable default — the endpoint must be explicit.
    // CloudWatch may derive every signal endpoint from the region.
    if (!endpoint && backendEnv === "lgtm") {
      throw new Error("KAGERO_OTLP_ENDPOINT is required");
    }
    targets.push(mk(endpoint, backendEnv as "lgtm" | "cloudwatch"));
  }
  // Every setting was checked above, so an endpoint that fails here is a
  // CloudWatch default built from the region.
  for (const t of targets) {
    for (const v of [t.endpoint, t.endpointTraces, t.endpointMetrics]) {
      if (v !== undefined && !isOtlpBaseUrl(v)) {
        const key = env.KAGERO_AWS_REGION !== undefined ? "KAGERO_AWS_REGION" : "AWS_REGION";
        throw new Error(`${key} does not make a valid CloudWatch OTLP endpoint URL`);
      }
    }
  }

  const fetcher = lambdaApiFetcher({ region });
  return (event: unknown) => stitchNotification(event, { fetcher, targets });
}

/**
 * CloudWatch OTLP endpoints differ per signal (xray./monitoring./logs.
 * <region>.amazonaws.com) — a single base cannot reach all of them.
 * Resolution order matches the agent's collector: per-signal override →
 * shared CloudWatch endpoint (VPC endpoints) → region-derived AWS default.
 * Throws when nothing resolves a signal (no overrides, no shared, no
 * region).
 */
export function resolveCwEndpoints(
  env: Record<string, string | undefined>,
  region: string | undefined,
  shared: string | undefined,
): { logs: string; traces: string; metrics: string } {
  const derived = (host: string) =>
    region ? `https://${host}.${region}.amazonaws.com` : undefined;
  // Empty string = unset, matching the agent's env_endpoint (an env var
  // set-but-empty must not shadow the shared/region fallback).
  const nz = (s: string | undefined) => (s === "" ? undefined : s);
  const logs = nz(env.KAGERO_OTLP_ENDPOINT_CLOUDWATCH_LOGS) ?? nz(shared) ?? derived("logs");
  const traces = nz(env.KAGERO_OTLP_ENDPOINT_CLOUDWATCH_TRACES) ?? nz(shared) ?? derived("xray");
  const metrics =
    nz(env.KAGERO_OTLP_ENDPOINT_CLOUDWATCH_METRICS) ?? nz(shared) ?? derived("monitoring");
  if (!logs || !traces || !metrics) {
    throw new Error(
      "cloudwatch backend needs KAGERO_OTLP_ENDPOINT (or per-signal " +
        "overrides), or a region for AWS defaults",
    );
  }
  return { logs, traces, metrics };
}

/**
 * Deployment entry — a NodejsFunction points at this module with
 * `handler: "handler"`. Initialised lazily so importing the package
 * does not require deployment env vars. KAGERO_*_SECRET_ARN env vars
 * are resolved via Secrets Manager once per execution environment
 * (ADR-011: only the ARN travels in env, never the secret).
 */
let lazyHandler: Promise<(event: unknown) => Promise<StitchResult>> | undefined;
export const handler = async (event: unknown): Promise<StitchResult> => {
  // Reset on failure — caching a rejected init would poison the warm
  // execution environment until Lambda retires it.
  lazyHandler ??= resolveSecretArns(process.env)
    .then((env) => handlerFromEnv(env))
    .catch((err: unknown) => {
      lazyHandler = undefined;
      throw err;
    });
  return (await lazyHandler)(event);
};
