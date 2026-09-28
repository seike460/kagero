import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postRunAnnotation } from "./annotations.js";
import { baseMetricName, EmfEncoder, k6JsonToEmf } from "./emf.js";
import { outputFromEnv } from "./index.js";
import { k6Args, k6OtelEnv, type RunShardInput, runShard } from "./runner.js";
import { waitForStart } from "./schedule.js";
import { planShards, shardSpec } from "./shard.js";

/** Local HTTP server for the real-fetch paths; close() also drops
 *  connections the handler left open. */
async function listen(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Index-or-throw — keeps tests free of non-null assertions. */
function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`missing index ${i}`);
  return v;
}

describe("shardSpec", () => {
  it("produces the documented segment and sequence for 3 shards", () => {
    // Verified against k6 docs: segment "i/n:(i+1)/n", sequence lists
    // every boundary value.
    expect(shardSpec(0, 3)).toEqual({
      index: 0,
      count: 3,
      segment: "0:1/3",
      sequence: "0,1/3,2/3,1",
    });
    expect(shardSpec(1, 3).segment).toBe("1/3:2/3");
    expect(shardSpec(2, 3).segment).toBe("2/3:1");
  });

  it("covers 1 and 4 shards", () => {
    expect(shardSpec(0, 1)).toEqual({ index: 0, count: 1, segment: "0:1", sequence: "0,1" });
    expect(shardSpec(3, 4).segment).toBe("3/4:1");
    expect(shardSpec(3, 4).sequence).toBe("0,1/4,2/4,3/4,1");
  });

  it("rejects invalid index and count", () => {
    expect(() => shardSpec(3, 3)).toThrow();
    expect(() => shardSpec(-1, 2)).toThrow();
    expect(() => shardSpec(0, 0)).toThrow();
    expect(() => planShards(0)).toThrow();
  });

  it("planShards returns one spec per shard sharing the sequence", () => {
    const specs = planShards(4);
    expect(specs).toHaveLength(4);
    for (const s of specs) expect(s.sequence).toBe("0,1/4,2/4,3/4,1");
  });
});

describe("waitForStart", () => {
  function fakeClock(startMs: number) {
    let t = startMs;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  }

  it("waits until the start time and reports zero skew", async () => {
    const c = fakeClock(1000);
    const r = await waitForStart(5000, c);
    expect(r.waitedMs).toBe(4000);
    expect(r.skewMs).toBe(0);
  });

  it("starts immediately when already past, reporting lateness as skew", async () => {
    const c = fakeClock(6000);
    const r = await waitForStart(5000, c);
    expect(r.waitedMs).toBe(0);
    expect(r.skewMs).toBe(1000);
  });

  it("rejects schedules beyond the forward bound", async () => {
    const c = fakeClock(0);
    await expect(waitForStart(1000, c, 500)).rejects.toThrow(/beyond/);
  });
});

// Verified k6 json-output shapes (grafana.com/docs/k6 results json doc).
const K6_LINES = [
  '{"type":"Metric","data":{"type":"trend","contains":"time"},"metric":"http_req_duration"}',
  '{"type":"Point","data":{"time":"2026-09-01T00:00:01.000Z","value":459.8,"tags":{"status":"200","url":"https://x"}},"metric":"http_req_duration"}',
  '{"type":"Point","data":{"time":"2026-09-01T00:00:02.000Z","value":120.5,"tags":{"status":"500"}},"metric":"http_req_duration"}',
  '{"type":"Metric","data":{"type":"counter","contains":"data"},"metric":"data_received"}',
  '{"type":"Point","data":{"time":"2026-09-01T00:00:02.000Z","value":1024,"tags":null},"metric":"data_received"}',
  // The submetric point below duplicates a parent point — it must be
  // dropped, not folded, or every matching sample counts twice.
  '{"type":"Point","data":{"time":"2026-09-01T00:00:02.000Z","value":1,"tags":{"status":"200"}},"metric":"http_req_duration{status:200}"}',
];

interface EmfRec {
  _aws: {
    Timestamp: number;
    CloudWatchMetrics: {
      Namespace: string;
      Dimensions: string[][];
      Metrics: { Name: string; Unit: string }[];
    }[];
  };
  [k: string]: unknown;
}

describe("EmfEncoder", () => {
  it("emits spec-shaped EMF records with run/shard dimensions", () => {
    const r = k6JsonToEmf(K6_LINES, { runId: "r1", shardId: "0" }, "kagero/k6");
    // One submetric point dropped — nothing else skipped.
    expect(r.skipped).toBe(1);
    // Per-second buckets: h@1s, d@2s, h@2s.
    expect(r.emfLines).toHaveLength(3);
    const recs = r.emfLines.map((l) => JSON.parse(l) as EmfRec);
    const byName = new Map(
      recs.map((rec) => [at(at(rec._aws.CloudWatchMetrics, 0).Metrics, 0).Name, rec] as const),
    );
    const h1 = byName.get("http_req_duration");
    const d = byName.get("data_received");
    if (!h1 || !d) throw new Error("missing metrics");
    const directive = at(h1._aws.CloudWatchMetrics, 0);
    expect(directive.Namespace).toBe("kagero/k6");
    expect(directive.Dimensions).toEqual([["kagero.k6.run.id", "kagero.k6.shard.id"]]);
    expect(directive.Metrics).toEqual([{ Name: "http_req_duration", Unit: "Milliseconds" }]);
    // No double count: only the two parent points, split by second.
    const hValues = recs
      .filter(
        (rec) => at(at(rec._aws.CloudWatchMetrics, 0).Metrics, 0).Name === "http_req_duration",
      )
      .flatMap((rec) => rec.http_req_duration as number[]);
    expect(hValues).toEqual([459.8, 120.5]);
    expect(d.data_received).toBe(1024);
    expect(h1["kagero.k6.run.id"]).toBe("r1");
    expect(h1["kagero.k6.shard.id"]).toBe("0");
    // No k6 per-point tag ever becomes a dimension or property.
    expect(h1.status).toBeUndefined();
    expect(h1.url).toBeUndefined();
    // Timestamps keep the time axis (per-second buckets).
    const ts = recs.map((rec) => rec._aws.Timestamp).sort();
    expect(ts).toEqual([1000, 2000, 2000].map((x) => Date.parse("2026-09-01T00:00:00Z") + x));
  });

  it("chunks values at the EMF 100-value limit", () => {
    const enc = new EmfEncoder({ runId: "r", shardId: "1" });
    enc.feed('{"type":"Metric","data":{"type":"counter"},"metric":"iterations"}');
    for (let i = 0; i < 250; i++) {
      enc.feed(`{"type":"Point","data":{"value":1},"metric":"iterations"}`);
    }
    const lines = enc.flush();
    expect(lines).toHaveLength(3);
    const first = JSON.parse(at(lines, 0)) as { iterations: number[] };
    expect(first.iterations).toHaveLength(100);
    const last = JSON.parse(at(lines, 2)) as { iterations: number[] };
    expect(last.iterations).toHaveLength(50);
  });

  it("skips malformed lines without throwing", () => {
    const r = k6JsonToEmf(
      ["not json", '{"type":"Weird"}', "", '{"type":"Point","data":{"value":1},"metric":"m"}'],
      { runId: "r", shardId: "0" },
    );
    expect(r.skipped).toBe(2);
    expect(r.emfLines).toHaveLength(1);
  });

  it("rejects namespaces starting with AWS/", () => {
    expect(() => new EmfEncoder({ runId: "r", shardId: "0" }, "AWS/x")).toThrow();
  });

  it("drains full value-chunks and retired buckets before flush", () => {
    const enc = new EmfEncoder({ runId: "r", shardId: "1" });
    enc.feed('{"type":"Metric","data":{"type":"counter"},"metric":"iterations"}');
    for (let i = 0; i < 250; i++) {
      enc.feed(
        `{"type":"Point","data":{"time":"2026-09-01T00:00:01Z","value":1},"metric":"iterations"}`,
      );
    }
    // Two full 100-value chunks emitted mid-stream — not held to flush.
    expect(enc.drain()).toHaveLength(2);
    // A newer second retires the older remainder bucket too.
    enc.feed(
      `{"type":"Point","data":{"time":"2026-09-01T00:00:05Z","value":2},"metric":"iterations"}`,
    );
    expect(enc.drain()).toHaveLength(1);
    // Only the newest second stays buffered for flush.
    expect(enc.flush()).toHaveLength(1);
    expect(enc.drain()).toHaveLength(0);
  });

  it("emits a straggler bucket before flush", () => {
    const enc = new EmfEncoder({ runId: "r", shardId: "1" });
    enc.feed(`{"type":"Point","data":{"time":"2026-09-01T00:00:05Z","value":1},"metric":"m"}`);
    // A point below the watermark reopens an out-of-window bucket —
    // it must be retired and drained now, not held for flush.
    enc.feed(`{"type":"Point","data":{"time":"2026-09-01T00:00:01Z","value":2},"metric":"m"}`);
    expect(enc.drain()).toHaveLength(1);
    expect(enc.flush()).toHaveLength(1); // the 5s bucket remains
  });

  it("baseMetricName folds submetrics into the parent", () => {
    expect(baseMetricName("http_req_duration{status:200}")).toBe("http_req_duration");
    expect(baseMetricName("iterations")).toBe("iterations");
  });
});

const BASE_INPUT: RunShardInput = {
  scriptPath: "/opt/script.js",
  runId: "run-1",
  shardIndex: 1,
  shardCount: 3,
  startAtMs: 5000,
  output: { kind: "json-file", path: "/tmp/out.json" },
};

describe("k6Args", () => {
  it("builds the documented distributed-run command line", () => {
    const args = k6Args(BASE_INPUT);
    const joined = args.join(" ");
    expect(joined).toContain("--execution-segment 1/3:2/3");
    expect(joined).toContain("--execution-segment-sequence 0,1/3,2/3,1");
    expect(joined).toContain("--tag run_id=run-1");
    expect(joined).toContain("--tag shard_id=1");
    expect(args.at(-1)).toBe("/opt/script.js");
  });

  it("uses -o opentelemetry for otlp output", () => {
    const args = k6Args({
      ...BASE_INPUT,
      output: { kind: "otlp", exporterType: "http", endpoint: "x:4318" },
    });
    const i = args.indexOf("-o");
    expect(at(args, i + 1)).toBe("opentelemetry");
  });
});

describe("k6OtelEnv", () => {
  it("emits the documented env names for http (k6 ≥1.4 protocol name)", () => {
    const env = k6OtelEnv({
      kind: "otlp",
      exporterType: "http",
      endpoint: "h:4318",
      insecure: true,
      urlPath: "/v1/metrics",
      metricPrefix: "k6_",
      headers: "Authorization=Basic abc",
      username: "u",
      password: "p",
    });
    expect(env).toEqual({
      // K6_OTEL_EXPORTER_TYPE was removed in k6 v2 — PROTOCOL it is.
      K6_OTEL_EXPORTER_PROTOCOL: "http/protobuf",
      K6_OTEL_HTTP_EXPORTER_ENDPOINT: "h:4318",
      K6_OTEL_HTTP_EXPORTER_INSECURE: "true",
      K6_OTEL_HTTP_EXPORTER_URL_PATH: "/v1/metrics",
      K6_OTEL_HTTP_EXPORTER_USERNAME: "u",
      K6_OTEL_HTTP_EXPORTER_PASSWORD: "p",
      K6_OTEL_METRIC_PREFIX: "k6_",
      K6_OTEL_HEADERS: "Authorization=Basic abc",
    });
  });

  it("emits the grpc endpoint when type is grpc", () => {
    const env = k6OtelEnv({
      kind: "otlp",
      exporterType: "grpc",
      endpoint: "c:4317",
      insecure: true,
    });
    expect(env.K6_OTEL_GRPC_EXPORTER_ENDPOINT).toBe("c:4317");
    expect(env.K6_OTEL_HTTP_EXPORTER_ENDPOINT).toBeUndefined();
  });
});

describe("runShard", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kagero-k6-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function fakeDeps(nowRef: { t: number }) {
    return {
      clock: {
        now: () => nowRef.t,
        sleep: async (ms: number) => {
          nowRef.t += ms;
        },
      },
    };
  }

  it("waits, spawns k6, converts emf, and propagates the exit code", async () => {
    const now = { t: 4500 };
    const spawned: { args: string[]; env: Record<string, string | undefined> }[] = [];
    const emitted: string[] = [];
    const r = await runShard(
      {
        ...BASE_INPUT,
        shardIndex: 0,
        shardCount: 2,
        output: { kind: "emf", namespace: "kagero/k6" },
        jsonOutPath: join(dir, "k6-out.json"),
      },
      {
        ...fakeDeps(now),
        spawn: async (_cmd, args, env) => {
          spawned.push({ args, env });
          now.t += 10; // k6 itself takes ~10ms
          return { code: 0, stdout: "", stderr: "" };
        },
        readLinesFn: async function* () {
          yield* K6_LINES;
        },
        emit: (l) => emitted.push(l),
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.skewMs).toBe(0); // waited 500ms then started exactly on time
    expect(r.emfLines).toBe(3);
    expect(r.emfSkipped).toBe(1); // the submetric point
    expect(emitted.every((l) => l.includes('"Namespace":"kagero/k6"'))).toBe(true);
    expect(at(spawned, 0).args.join(" ")).toContain("--execution-segment 0:1/2");
  });

  it("returns the exit code when k6 dies before writing the json file", async () => {
    const r = await runShard(
      { ...BASE_INPUT, output: { kind: "emf" }, jsonOutPath: join(dir, "none.json") },
      {
        clock: { now: () => 4999, sleep: async () => {} },
        spawn: async () => ({ code: 108, stdout: "", stderr: "script error" }),
        readLinesFn: () => {
          throw new Error("ENOENT");
        },
        emit: () => {},
      },
    );
    expect(r.exitCode).toBe(108);
    expect(r.emfLines).toBe(0);
    expect(r.emfSkipped).toBe(1);
  });

  it("never re-emits the json file a previous shard left behind", async () => {
    const jsonOutPath = join(dir, "k6-out.json");
    // A warm execution environment keeps /tmp from the last invocation.
    await writeFile(jsonOutPath, `${at(K6_LINES, 1)}\n`);
    const emitted: string[] = [];
    const r = await runShard(
      { ...BASE_INPUT, output: { kind: "emf" }, jsonOutPath },
      {
        clock: { now: () => 4999, sleep: async () => {} },
        // k6 fails to compile the script and never opens its output.
        spawn: async () => ({ code: 107, stdout: "", stderr: "could not initialize" }),
        emit: (l) => emitted.push(l),
      },
    );
    expect(r.exitCode).toBe(107);
    expect(r.emfLines).toBe(0);
    expect(emitted).toEqual([]);
  });

  it("refuses extra tags that smuggle forbidden metric labels", () => {
    expect(() => k6Args({ ...BASE_INPUT, extraTags: { "kagero.tenant.id": "x" } })).toThrow(
      /forbidden/,
    );
    expect(() => k6Args({ ...BASE_INPUT, extraTags: { tenant_id: "x" } })).toThrow(/forbidden/);
    expect(() => k6Args({ ...BASE_INPUT, extraTags: { method: "GET" } })).not.toThrow();
  });

  it("reports lateness as skew when already past startAtMs", async () => {
    const now = { t: 7000 };
    const r = await runShard(BASE_INPUT, {
      ...fakeDeps(now),
      spawn: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    expect(r.skewMs).toBe(2000);
  });

  it("propagates a failing threshold exit code", async () => {
    const r = await runShard(BASE_INPUT, {
      clock: { now: () => 4999, sleep: async () => {} },
      spawn: async () => ({ code: 99, stdout: "", stderr: "thresholds failed" }),
    });
    expect(r.exitCode).toBe(99);
  });

  it("posts a region annotation when grafana is configured", async () => {
    const posts: { url: string; body: { time: number; timeEnd: number; tags: string[] } }[] = [];
    await runShard(
      {
        ...BASE_INPUT,
        grafana: { endpoint: "https://g.example.com", token: "t" },
      },
      {
        clock: {
          now: () => 5000,
          sleep: async () => {},
        },
        spawn: async () => ({ code: 0, stdout: "", stderr: "" }),
        fetchImpl: async (url, init) => {
          posts.push({ url, body: JSON.parse(init.body) });
          return { ok: true, status: 200 };
        },
      },
    );
    expect(at(posts, 0).url).toBe("https://g.example.com/api/annotations");
    expect(at(posts, 0).body.tags).toContain("run:run-1");
    expect(at(posts, 0).body.timeEnd).toBeGreaterThanOrEqual(at(posts, 0).body.time);
  });
});

describe("outputFromEnv", () => {
  const base = {
    scriptPath: "/s.js",
    runId: "r",
    shardIndex: 0,
    shardCount: 1,
    startAtMs: 0,
  };

  it("maps the collector backend to the local insecure otlp endpoint", () => {
    const o = outputFromEnv({ ...base, backend: "collector" }, {} as NodeJS.ProcessEnv);
    expect(o).toEqual({
      kind: "otlp",
      exporterType: "grpc",
      endpoint: "127.0.0.1:4317",
      insecure: true,
    });
  });

  it("maps cloudwatch to emf", () => {
    const o = outputFromEnv({ ...base, backend: "cloudwatch" }, {} as NodeJS.ProcessEnv);
    expect(o).toEqual({ kind: "emf", namespace: "kagero/k6" });
  });

  it("requires KAGERO_OTLP_ENDPOINT for lgtm", () => {
    expect(() => outputFromEnv({ ...base, backend: "lgtm" }, {} as NodeJS.ProcessEnv)).toThrow();
    const o = outputFromEnv({ ...base, backend: "lgtm" }, {
      KAGERO_OTLP_ENDPOINT: "h:4318",
    } as NodeJS.ProcessEnv);
    expect(o).toMatchObject({ kind: "otlp", exporterType: "http", endpoint: "h:4318" });
  });
});

describe("postRunAnnotation", () => {
  const RUN = { startMs: 1000, endMs: 2000, runId: "r", shardCount: 2 };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gives up on a Grafana that accepts the POST and never answers", async () => {
    const grafana = await listen(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await postRunAnnotation({ endpoint: grafana.url, token: "t", timeoutMs: 100 }, RUN);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("grafana annotation POST failed"));
    } finally {
      await grafana.close();
    }
  });

  it("bounds the POST with a timeout signal by default", async () => {
    let signal: AbortSignal | undefined;
    await postRunAnnotation(
      { endpoint: "https://g.example.com", token: "t" },
      RUN,
      async (_u, i) => {
        signal = i.signal;
        return { ok: true, status: 200 };
      },
    );
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });
});
