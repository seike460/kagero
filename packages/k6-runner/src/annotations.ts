/**
 * Grafana annotations for test start/end (§3-3). One region annotation
 * per run (time → timeEnd) — verified POST /api/annotations shape:
 * {time, timeEnd, tags, text} with ms epoch; auth is a bearer token
 * with the annotations:create scope.
 *
 * The token is deployment config (same trust level as the OTLP header
 * env in the stitcher) — never logged, never in image env vars per
 * ADR-011.
 */

export interface GrafanaAnnotations {
  /** Base URL, e.g. "https://grafana.example.com", with an optional
   *  prefix path. Trailing slashes are dropped and "/api/annotations" is
   *  appended as text, so it takes no query, fragment or userinfo;
   *  handlerFromEnv refuses such a KAGERO_GRAFANA_URL at init. */
  endpoint: string;
  /** Grafana service-account token with annotations:create. */
  token: string;
  /** POST timeout (default 5000 ms) — shard 0 returns its result only
   *  after the POST settles, so a hung Grafana must not hold it. */
  timeoutMs?: number;
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number }>;

export interface AnnotationInput {
  /** ms epoch. */
  startMs: number;
  endMs: number;
  runId: string;
  shardCount: number;
  text?: string;
}

/** One region annotation spanning the run. Fire-and-warn: a failed POST
 *  is logged, never thrown — annotations must not fail the load test. */
export async function postRunAnnotation(
  g: GrafanaAnnotations,
  a: AnnotationInput,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<void> {
  try {
    const res = await fetchImpl(`${g.endpoint.replace(/\/+$/, "")}/api/annotations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${g.token}`,
      },
      body: JSON.stringify({
        time: Math.trunc(a.startMs),
        timeEnd: Math.trunc(a.endMs),
        tags: ["kagero", "k6", `run:${a.runId}`],
        text: a.text ?? `kagero k6 run ${a.runId} (${a.shardCount} shard(s))`,
      }),
      signal: AbortSignal.timeout(g.timeoutMs ?? 5000),
    });
    if (!res.ok) {
      // An annotation failure must not fail the load test itself.
      console.warn(`grafana annotation POST failed: HTTP ${res.status}`);
    }
  } catch (e) {
    // Transport errors (DNS/connect/timeout) are failures too — warn,
    // never reject.
    console.warn(`grafana annotation POST failed: ${fetchFailure(e)}`);
  }
}

/** Why fetch failed, without its message: some messages quote the whole
 *  URL ("Failed to parse URL from …", "…includes credentials: …"), and
 *  the endpoint's userinfo, path or query may carry a token. The error
 *  name and the network error code (ECONNREFUSED, ENOTFOUND…) do not. */
function fetchFailure(e: unknown): string {
  if (!(e instanceof Error)) return "unknown error";
  const code = (e.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? `${e.name} (${code})` : e.name;
}
