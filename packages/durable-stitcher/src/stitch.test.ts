import { describe, expect, it } from "vitest";
import { parseEventBridge } from "./events.js";
import { fixtureFetcher, normalizeApiResponse } from "./fetcher.js";
import { handlerFromEnv, resolveCwEndpoints, stitchNotification } from "./index.js";
import {
  type ExecutionRecord,
  type HistoryApiEvent,
  normalizeTransitions,
  toDate,
} from "./model.js";
import { metricsPayload, type Send, tracesPayload } from "./otlp.js";
import { assembleTrace, replayCount, traceIdFor } from "./stitch.js";

/** Index-or-throw — keeps tests free of non-null assertions. */
function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`missing index ${i}`);
  return v;
}

const ARN =
  "arn:aws:lambda:us-east-1:123456789012:function:checkout:$LATEST/durable-execution/090c4189-b18b-4296-9d0c-cfd01dc3a122/9f7d84c9-ea3d-3ffc-b3e5-5ec51c34ffc9";

const rec: ExecutionRecord = {
  executionArn: ARN,
  name: "checkout-42",
  status: "succeeded",
  startTime: new Date("2026-09-01T00:00:00Z"),
  endTime: new Date("2026-09-01T00:05:00Z"),
  replayCount: 2,
  events: [
    {
      id: "e1",
      kind: "step",
      name: "charge-card",
      status: "succeeded",
      startTime: new Date("2026-09-01T00:00:05Z"),
      endTime: new Date("2026-09-01T00:00:35Z"),
      links: [{ traceId: "aa".repeat(16), spanId: "bb".repeat(8) }],
    },
    {
      id: "e2",
      kind: "wait",
      name: "wait-confirm",
      status: "succeeded",
      startTime: new Date("2026-09-01T00:00:35Z"),
      endTime: new Date("2026-09-01T00:02:35Z"),
    },
    {
      id: "e3",
      kind: "retry",
      name: "charge-card",
      status: "failed",
      attempt: 2,
      startTime: new Date("2026-09-01T00:02:40Z"),
      endTime: new Date("2026-09-01T00:03:10Z"),
    },
  ],
};

describe("assembleTrace", () => {
  it("produces deterministic trace/span ids from the execution arn", () => {
    const a = assembleTrace(rec);
    const b = assembleTrace(rec);
    expect(a.traceId).toBe(b.traceId);
    expect(a.traceId).toBe(traceIdFor(ARN));
    expect(a.spans.map((s) => s.spanId)).toEqual(b.spans.map((s) => s.spanId));
    expect(a.traceId).toMatch(/^[0-9a-f]{32}$/);
    for (const s of a.spans) expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("builds one root span plus one span per event, parented correctly", () => {
    const t = assembleTrace(rec);
    const root = at(t.spans, 0);
    expect(root.parentSpanId).toBeUndefined();
    expect(root.kind).toBe(2); // SERVER
    expect(t.spans).toHaveLength(1 + rec.events.length);
    for (const c of t.spans.slice(1)) {
      expect(c.parentSpanId).toBe(root.spanId);
      expect(c.kind).toBe(1); // INTERNAL
    }
    // children sorted by startTime
    const names = t.spans.slice(1).map((s) => s.name);
    expect(names).toEqual(["step: charge-card", "wait: wait-confirm", "retry: charge-card"]);
  });

  it("puts the replay count and identity on the root span", () => {
    const root = at(assembleTrace(rec).spans, 0);
    const m = Object.fromEntries(root.attributes.map((a) => [a.key, a.value]));
    expect(m["kagero.durable.execution.arn"]).toEqual({ stringValue: ARN });
    expect(m["kagero.durable.replay_count"]).toEqual({ intValue: "2" });
    expect(m["kagero.durable.status"]).toEqual({ stringValue: "succeeded" });
  });

  it("attaches span links to invocation traces", () => {
    const step = at(assembleTrace(rec).spans, 1);
    expect(step.links).toEqual([{ traceId: "aa".repeat(16), spanId: "bb".repeat(8) }]);
  });

  it("maps terminal failure to ERROR status", () => {
    const failed = { ...rec, status: "failed" as const };
    expect(at(assembleTrace(failed).spans, 0).status.code).toBe(2);
    const timedOut = { ...rec, status: "timed_out" as const };
    expect(at(assembleTrace(timedOut).spans, 0).status.code).toBe(2);
  });

  it("nests children under a resolved parentId", () => {
    const nested: ExecutionRecord = {
      ...rec,
      events: [at(rec.events, 0), { ...at(rec.events, 2), id: "e3", parentId: "e1" }],
    };
    const t = assembleTrace(nested);
    const child = at(t.spans, 2);
    expect(child.parentSpanId).toBe(at(t.spans, 1).spanId);
  });
});

describe("replayCount", () => {
  it("is the max of reported count and retry-shaped evidence", () => {
    expect(replayCount({ ...rec, replayCount: 5 })).toBe(5);
    expect(replayCount({ ...rec, replayCount: 0 })).toBe(1); // e3: kind retry
    const noRetries: ExecutionRecord = { ...rec, replayCount: 0, events: rec.events.slice(0, 2) };
    expect(replayCount(noRetries)).toBe(0);
  });
});

describe("normalizeTransitions (real API shape)", () => {
  it("pairs Started/terminal events sharing one Id", () => {
    const evs: HistoryApiEvent[] = [
      { EventId: 1, EventType: "StepStarted", EventTimestamp: 1750000000, Id: "s1", Name: "a" },
      { EventId: 2, EventType: "StepSucceeded", EventTimestamp: 1750000010, Id: "s1" },
      { EventId: 3, EventType: "WaitStarted", EventTimestamp: 1750000011, Id: "w1" },
    ];
    const out = normalizeTransitions(evs);
    expect(out).toHaveLength(2);
    expect(at(out, 0).kind).toBe("step");
    expect(at(out, 0).status).toBe("succeeded");
    expect(at(out, 0).endTime).toEqual(new Date(1750000010 * 1000));
    // unpaired start stays open
    expect(at(out, 1).kind).toBe("wait");
    expect(at(out, 1).status).toBe("running");
    expect(at(out, 1).endTime).toBeUndefined();
  });

  it("marks a second cycle on the same Id as a retry", () => {
    const evs: HistoryApiEvent[] = [
      { EventId: 1, EventType: "StepStarted", EventTimestamp: 1750000000, Id: "s1", Name: "a" },
      {
        EventId: 2,
        EventType: "StepFailed",
        EventTimestamp: 1750000005,
        Id: "s1",
        StepFailedDetails: { RetryDetails: { CurrentAttempt: 1, NextAttemptDelaySeconds: 2 } },
      },
      { EventId: 3, EventType: "StepStarted", EventTimestamp: 1750000007, Id: "s1", Name: "a" },
      { EventId: 4, EventType: "StepSucceeded", EventTimestamp: 1750000012, Id: "s1" },
    ];
    const out = normalizeTransitions(evs);
    expect(out).toHaveLength(2);
    expect(at(out, 0).status).toBe("failed");
    expect(at(out, 0).attempt).toBe(1);
    expect(at(out, 1).kind).toBe("retry");
    expect(at(out, 1).id).toBe("s1#2");
    expect(at(out, 1).status).toBe("succeeded");
  });

  it("skips execution-level events (no Id)", () => {
    const evs: HistoryApiEvent[] = [
      { EventId: 1, EventType: "ExecutionStarted", EventTimestamp: 1750000000 },
      { EventId: 2, EventType: "InvocationCompleted", EventTimestamp: 1750000005 },
    ];
    expect(normalizeTransitions(evs)).toHaveLength(0);
  });
});

describe("toDate", () => {
  it("handles epoch seconds, epoch ms, ISO strings and Date", () => {
    expect(toDate(1750000000)).toEqual(new Date(1750000000 * 1000));
    expect(toDate(1750000000000)).toEqual(new Date(1750000000000));
    expect(toDate("2026-09-01T00:00:00Z")).toEqual(new Date("2026-09-01T00:00:00Z"));
    const d = new Date();
    expect(toDate(d)).toBe(d);
    expect(toDate(undefined)).toBeUndefined();
  });
});

describe("parseEventBridge (verified event shape)", () => {
  it("extracts arn + status + name from a status-change event", () => {
    const note = parseEventBridge({
      "detail-type": "Durable Execution Status Change",
      source: "aws.lambda",
      detail: {
        durableExecutionArn: ARN,
        durableExecutionName: "order-123",
        functionArn: "arn:aws:lambda:us-east-1:123456789012:function:checkout:2",
        status: "SUCCEEDED",
        startTimestamp: "2026-09-01T00:00:00Z",
        endTimestamp: "2026-09-01T00:05:00Z",
      },
    });
    expect(note.executionArn).toBe(ARN);
    expect(note.status).toBe("succeeded");
    expect(note.name).toBe("order-123");
  });

  it("rejects events without a valid durable execution arn", () => {
    expect(() => parseEventBridge({ detail: { status: "SUCCEEDED" } })).toThrow(
      /durableExecutionArn/,
    );
    expect(() =>
      parseEventBridge({
        detail: {
          durableExecutionArn: "arn:aws:lambda:us-east-1:123456789012:function:f",
          status: "SUCCEEDED",
        },
      }),
    ).toThrow(/ARN/);
  });

  it("rejects unknown status", () => {
    expect(() =>
      parseEventBridge({ detail: { durableExecutionArn: ARN, status: "MYSTERIOUS" } }),
    ).toThrow(/status/);
  });
});

describe("normalizeApiResponse (real API shape)", () => {
  it("derives execution facts from Execution* events", () => {
    const r = normalizeApiResponse(ARN, {
      Events: [
        { EventId: 1, EventType: "ExecutionStarted", EventTimestamp: 1750000000 },
        { EventId: 2, EventType: "StepStarted", EventTimestamp: 1750000001, Id: "s1", Name: "a" },
        {
          EventId: 3,
          EventType: "StepFailed",
          EventTimestamp: 1750000009,
          Id: "s1",
          StepFailedDetails: { RetryDetails: { CurrentAttempt: 2, NextAttemptDelaySeconds: 5 } },
        },
        { EventId: 4, EventType: "InvocationCompleted", EventTimestamp: 1750000010 },
        { EventId: 5, EventType: "InvocationCompleted", EventTimestamp: 1750000012 },
        { EventId: 6, EventType: "ExecutionSucceeded", EventTimestamp: 1750000300 },
      ],
    });
    expect(r.name).toBe("090c4189-b18b-4296-9d0c-cfd01dc3a122");
    expect(r.status).toBe("succeeded");
    expect(r.startTime).toEqual(new Date(1750000000 * 1000));
    expect(r.endTime).toEqual(new Date(1750000300 * 1000));
    expect(r.replayCount).toBe(1); // 2 invocations − 1
    expect(r.events).toHaveLength(1);
    expect(at(r.events, 0).status).toBe("failed");
    expect(at(r.events, 0).attempt).toBe(2);
  });

  it("uses the LAST terminal event — a mid-history failure superseded by a retry wins", () => {
    // Replay after failure: ExecutionFailed at seq 3 is a real terminal
    // for that invocation, but the execution restarted (seq 4) and later
    // succeeded. The record must reflect the final outcome.
    const r = normalizeApiResponse(ARN, {
      Events: [
        { EventId: 1, EventType: "ExecutionStarted", EventTimestamp: 1750000000 },
        { EventId: 2, EventType: "InvocationCompleted", EventTimestamp: 1750000005 },
        { EventId: 3, EventType: "ExecutionFailed", EventTimestamp: 1750000006 },
        { EventId: 4, EventType: "ExecutionStarted", EventTimestamp: 1750000010 },
        { EventId: 5, EventType: "InvocationCompleted", EventTimestamp: 1750000020 },
        { EventId: 6, EventType: "ExecutionSucceeded", EventTimestamp: 1750000030 },
      ],
    });
    expect(r.status).toBe("succeeded");
    expect(r.endTime).toEqual(new Date(1750000030 * 1000));
  });
});

describe("payloads", () => {
  it("trace payload emits OTLP/JSON resourceSpans", () => {
    const p = tracesPayload(assembleTrace(rec)) as {
      resourceSpans: { scopeSpans: { spans: { traceId: string }[] }[] }[];
    };
    const spans = at(at(p.resourceSpans, 0).scopeSpans, 0).spans;
    expect(spans).toHaveLength(4);
    expect(at(spans, 0).traceId).toBe(traceIdFor(ARN));
  });

  it("metrics payload: no identity attrs, bucket invariant holds", () => {
    const p = metricsPayload(rec) as {
      resourceMetrics: {
        scopeMetrics: {
          metrics: {
            name: string;
            sum?: { dataPoints: { attributes?: { key: string }[] }[] };
            histogram?: { dataPoints: { bucketCounts: string[]; count: string }[] };
          }[];
        }[];
      }[];
    };
    const metrics = at(at(p.resourceMetrics, 0).scopeMetrics, 0).metrics;
    expect(metrics.map((m) => m.name)).toEqual([
      "kagero.durable.executions",
      "kagero.durable.replays",
      "kagero.durable.execution.duration_seconds",
    ]);
    for (const m of metrics) {
      const dps = m.sum?.dataPoints ?? m.histogram?.dataPoints ?? [];
      for (const dp of dps) {
        for (const a of (dp as { attributes?: { key: string }[] }).attributes ?? []) {
          // ADR-008: only the allowed enum label may appear.
          expect(a.key).toBe("kagero.durable.status");
        }
      }
    }
    const histMetric = at(metrics, 2).histogram;
    if (!histMetric) throw new Error("missing histogram");
    const hist = at(histMetric.dataPoints, 0);
    expect(hist.bucketCounts.reduce((a, b) => a + Number(b), 0)).toBe(Number(hist.count));
    expect(hist.bucketCounts.filter((c) => c === "1")).toHaveLength(1);
  });

  it("uses delta temporality — the stateless exporter cannot keep cumulative totals", () => {
    type SumDp = {
      sum?: { aggregationTemporality: number; isMonotonic: boolean };
      histogram?: { aggregationTemporality: number };
    };
    const p = metricsPayload(rec) as {
      resourceMetrics: { scopeMetrics: { metrics: SumDp[] }[] }[];
    };
    for (const m of at(at(p.resourceMetrics, 0).scopeMetrics, 0).metrics) {
      expect(m.sum?.aggregationTemporality ?? m.histogram?.aggregationTemporality).toBe(1);
    }
  });
});

describe("stitchNotification", () => {
  const terminalEvent = {
    "detail-type": "Durable Execution Status Change",
    detail: {
      durableExecutionArn: ARN,
      durableExecutionName: "order-123",
      status: "SUCCEEDED",
      startTimestamp: "2025-01-01T00:00:00Z",
      endTimestamp: "2025-01-01T00:00:09Z",
    },
  };
  const lgtmTarget = { endpoint: "http://localhost:4318", backend: "lgtm" as const };
  const noopSend: { sent: { url: string; body: Buffer }[]; post: Send["post"] } = {
    sent: [],
    async post(url: string, body: Buffer) {
      this.sent.push({ url, body });
    },
  };

  it("runs the full pipeline and posts traces then metrics", async () => {
    const sent: { url: string; body: Buffer }[] = [];
    const result = await stitchNotification(terminalEvent, {
      fetcher: fixtureFetcher(rec),
      targets: [lgtmTarget],
      send: {
        async post(url, body) {
          sent.push({ url, body });
        },
      },
    });
    expect(result.skipped).toBe(false);
    expect(result.traceId).toBe(traceIdFor(ARN));
    expect(result.spanCount).toBe(4);
    expect(sent.map((s) => s.url)).toEqual([
      "http://localhost:4318/v1/traces",
      "http://localhost:4318/v1/metrics",
    ]);
    const trace = JSON.parse(at(sent, 0).body.toString()) as {
      resourceSpans: { scopeSpans: { spans: unknown[] }[] }[];
    };
    expect(at(at(trace.resourceSpans, 0).scopeSpans, 0).spans).toHaveLength(4);
    const metrics = JSON.parse(at(sent, 1).body.toString()) as {
      resourceMetrics: { scopeMetrics: { metrics: { name: string }[] }[] }[];
    };
    expect(at(at(metrics.resourceMetrics, 0).scopeMetrics, 0).metrics.map((m) => m.name)).toContain(
      "kagero.durable.executions",
    );
  });

  it("fans out to every target on backend=both", async () => {
    const urls: string[] = [];
    const cwTarget = {
      endpoint: "https://cw.example.com",
      backend: "cloudwatch" as const,
      region: "us-east-1",
    };
    // The SigV4 path needs creds — stub them.
    process.env.AWS_ACCESS_KEY_ID = "test";
    process.env.AWS_SECRET_ACCESS_KEY = "test";
    try {
      const result = await stitchNotification(terminalEvent, {
        fetcher: fixtureFetcher(rec),
        targets: [lgtmTarget, cwTarget],
        send: {
          async post(url) {
            urls.push(url);
          },
        },
      });
      expect(result.skipped).toBe(false);
      expect(urls.sort()).toEqual([
        "http://localhost:4318/v1/metrics",
        "http://localhost:4318/v1/traces",
        "https://cw.example.com/v1/metrics",
        "https://cw.example.com/v1/traces",
      ]);
    } finally {
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
    }
  });

  it("throws on partial target failure so EventBridge retries (parity)", async () => {
    const delivered: string[] = [];
    await expect(
      stitchNotification(terminalEvent, {
        fetcher: fixtureFetcher(rec),
        targets: [lgtmTarget, { endpoint: "http://down:4318", backend: "lgtm" as const }],
        send: {
          async post(url) {
            if (url.includes("down")) throw new Error("refused");
            delivered.push(url);
          },
        },
      }),
    ).rejects.toThrow(/1\/2 target/);
    // The healthy target was still attempted — the retry may duplicate
    // it, which is the accepted cost of not losing the failing backend.
    expect(delivered).toEqual([
      "http://localhost:4318/v1/traces",
      "http://localhost:4318/v1/metrics",
    ]);
  });

  it("routes cloudwatch signals to per-signal endpoints", async () => {
    const urls: string[] = [];
    const cwTarget = {
      endpoint: "https://cw.example.com",
      endpointTraces: "https://xray.us-east-1.amazonaws.com",
      endpointMetrics: "https://monitoring.us-east-1.amazonaws.com",
      backend: "cloudwatch" as const,
      region: "us-east-1",
    };
    process.env.AWS_ACCESS_KEY_ID = "test";
    process.env.AWS_SECRET_ACCESS_KEY = "test";
    try {
      await stitchNotification(terminalEvent, {
        fetcher: fixtureFetcher(rec),
        targets: [cwTarget],
        send: {
          async post(url) {
            urls.push(url);
          },
        },
      });
      expect(urls.sort()).toEqual([
        "https://monitoring.us-east-1.amazonaws.com/v1/metrics",
        "https://xray.us-east-1.amazonaws.com/v1/traces",
      ]);
    } finally {
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
    }
  });

  it("delta metric windows use the execution's own [startTime, endTime]", () => {
    const p = metricsPayload(rec) as {
      resourceMetrics: {
        scopeMetrics: {
          metrics: {
            sum?: { dataPoints: { startTimeUnixNano: string; timeUnixNano: string }[] };
          }[];
        }[];
      }[];
    };
    const sum = at(at(at(p.resourceMetrics, 0).scopeMetrics, 0).metrics, 0).sum;
    const dp = at(sum?.dataPoints ?? [], 0);
    expect(dp.startTimeUnixNano).toBe(`${BigInt(rec.startTime.getTime()) * 1_000_000n}`);
    expect(dp.timeUnixNano).toBe(`${BigInt(rec.endTime?.getTime() ?? -1) * 1_000_000n}`);
  });

  it("handlerFromEnv requires the LGTM endpoint when KAGERO_BACKEND=both", () => {
    // LGTM is always required — it has no derivable default.
    expect(() =>
      handlerFromEnv({
        KAGERO_BACKEND: "both",
        KAGERO_OTLP_ENDPOINT_CLOUDWATCH: "https://cw.example.com",
      }),
    ).toThrow(/KAGERO_OTLP_ENDPOINT_LGTM/);
    // CloudWatch endpoint may be omitted ONLY when a region can derive
    // the AWS defaults — without one it still fails closed.
    expect(() =>
      handlerFromEnv({
        KAGERO_BACKEND: "both",
        KAGERO_OTLP_ENDPOINT_LGTM: "http://lgtm:4318",
        // KAGERO_OTLP_ENDPOINT_CLOUDWATCH intentionally absent, no region
      }),
    ).toThrow(/cloudwatch backend needs/);
    expect(() =>
      handlerFromEnv({
        KAGERO_BACKEND: "both",
        KAGERO_OTLP_ENDPOINT_LGTM: "http://lgtm:4318",
        AWS_REGION: "us-east-1",
      }),
    ).not.toThrow();
    expect(() =>
      handlerFromEnv({
        KAGERO_BACKEND: "both",
        KAGERO_OTLP_ENDPOINT_LGTM: "http://lgtm:4318",
        KAGERO_OTLP_ENDPOINT_CLOUDWATCH: "https://cw.example.com",
      }),
    ).not.toThrow();
    expect(() => handlerFromEnv({ KAGERO_BACKEND: "lgtm" })).toThrow(/KAGERO_OTLP_ENDPOINT/);
    // CloudWatch may derive every signal endpoint from the region — no
    // explicit endpoint required (AWS_REGION is always set on Lambda).
    expect(() =>
      handlerFromEnv({ KAGERO_BACKEND: "cloudwatch", AWS_REGION: "us-east-1" }),
    ).not.toThrow();
    // With neither endpoint nor region there is nothing resolvable.
    expect(() => handlerFromEnv({ KAGERO_BACKEND: "cloudwatch" })).toThrow(
      /cloudwatch backend needs/,
    );
  });

  it("resolveCwEndpoints orders per-signal → shared → region-derived", () => {
    // Nothing resolvable without region or any endpoint.
    expect(() => resolveCwEndpoints({}, undefined, undefined)).toThrow(/cloudwatch backend needs/);
    // Region derives all three AWS defaults.
    expect(resolveCwEndpoints({}, "us-east-1", undefined)).toEqual({
      logs: "https://logs.us-east-1.amazonaws.com",
      traces: "https://xray.us-east-1.amazonaws.com",
      metrics: "https://monitoring.us-east-1.amazonaws.com",
    });
    // Shared endpoint wins over region; per-signal wins over shared.
    const env = {
      KAGERO_OTLP_ENDPOINT_CLOUDWATCH_LOGS: "https://vpc-logs.example.com",
      KAGERO_OTLP_ENDPOINT_CLOUDWATCH_TRACES: "https://vpc-xray.example.com",
    };
    expect(resolveCwEndpoints(env, "us-east-1", "https://shared.example.com")).toEqual({
      logs: "https://vpc-logs.example.com",
      traces: "https://vpc-xray.example.com",
      metrics: "https://shared.example.com",
    });
    // KAGERO_OTLP_ENDPOINT_CLOUDWATCH is preferred over
    // KAGERO_OTLP_ENDPOINT as the shared value — the caller
    // (handlerFromEnv) folds them before calling.
    expect(resolveCwEndpoints({}, undefined, "https://shared.example.com")).toEqual({
      logs: "https://shared.example.com",
      traces: "https://shared.example.com",
      metrics: "https://shared.example.com",
    });
  });

  it("skips RUNNING notifications without fetching or exporting", async () => {
    let fetches = 0;
    const send = {
      sent: [] as { url: string }[],
      async post(url: string) {
        this.sent.push({ url });
      },
    };
    const result = await stitchNotification(
      {
        "detail-type": "Durable Execution Status Change",
        detail: { durableExecutionArn: ARN, status: "RUNNING" },
      },
      {
        fetcher: {
          async getHistory() {
            fetches++;
            return rec;
          },
        },
        targets: [lgtmTarget],
        send,
      },
    );
    expect(result.skipped).toBe(true);
    expect(result.status).toBe("running");
    expect(fetches).toBe(0);
    expect(send.sent).toHaveLength(0);
  });

  it("retries once when the history lags a terminal notification", async () => {
    const runningRec = { ...rec, status: "running" as const, endTime: undefined };
    let fetches = 0;
    const sleepCalls: number[] = [];
    const result = await stitchNotification(terminalEvent, {
      fetcher: {
        async getHistory() {
          fetches++;
          return fetches === 1 ? runningRec : rec;
        },
      },
      targets: [lgtmTarget],
      send: noopSend,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      retryDelayMs: 1234,
    });
    expect(result.skipped).toBe(false);
    expect(fetches).toBe(2);
    expect(sleepCalls).toEqual([1234]);
    expect(result.status).toBe("succeeded");
  });

  it("patches status from the notification when history stays running", async () => {
    const runningRec = { ...rec, status: "running" as const, endTime: undefined };
    const sent: { url: string; body: Buffer }[] = [];
    const result = await stitchNotification(terminalEvent, {
      fetcher: fixtureFetcher(runningRec),
      targets: [lgtmTarget],
      send: {
        async post(url, body) {
          sent.push({ url, body });
        },
      },
      sleep: async () => {},
    });
    expect(result.status).toBe("succeeded");
    expect(result.skipped).toBe(false);
    // The notification's endTimestamp must reach the root span end.
    const trace = JSON.parse(at(sent, 0).body.toString()) as {
      resourceSpans: {
        scopeSpans: { spans: { endTimeUnixNano?: string }[] }[];
      }[];
    };
    const root = at(at(at(trace.resourceSpans, 0).scopeSpans, 0).spans, 0);
    expect(root.endTimeUnixNano).toBe(
      String(BigInt(Date.parse("2025-01-01T00:00:09Z")) * 1_000_000n),
    );
  });

  it("prefers the notification name over the arn-derived name", async () => {
    let sawName: string | undefined;
    const result = await stitchNotification(terminalEvent, {
      fetcher: {
        async getHistory() {
          return { ...rec, name: "arn-segment-name" };
        },
      },
      targets: [lgtmTarget],
      send: {
        async post(url, body) {
          if (url.endsWith("/v1/traces")) {
            const t = JSON.parse(body.toString()) as {
              resourceSpans: {
                scopeSpans: {
                  spans: { attributes: { key: string; value: { stringValue?: string } }[] }[];
                }[];
              }[];
            };
            for (const a of at(at(at(t.resourceSpans, 0).scopeSpans, 0).spans, 0).attributes) {
              if (a.key === "kagero.durable.execution.name") sawName = a.value.stringValue;
            }
          }
        },
      },
    });
    expect(result.skipped).toBe(false);
    expect(sawName).toBe("order-123");
  });
});
