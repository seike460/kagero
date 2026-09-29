/**
 * The shipped collector templates (collector/) in the real collector.
 * The agent renders each template exactly as in a MicroVM, otelcol-contrib
 * (KAGERO_SIM_COLLECTOR_BIN) loads it, and the test app sends a metric
 * with forbidden identity attributes at resource, scope and datapoint
 * level (test-app.ts hostileMetric). The template's exporter points at a
 * receiver here, which decodes the OTLP protobuf and checks every level.
 * The E2E in e2e.test.ts runs a sim fixture instead, so a broken shipped
 * template would pass there.
 *
 * Only the collector's own sockets change, on its command line: the
 * self-metrics endpoint (fixed :8888) is off, and the gRPC receiver
 * (fixed 4317) takes a free port — parallel runs cannot collide. The
 * Alloy and Rotel templates need binaries that CI does not provide.
 */
import { createServer, type IncomingHttpHeaders, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { agentBin, testAppPath } from "./e2e.js";
import type { OtlpCapture } from "./mock-otlp.js";
import { startSim } from "./scenario.js";
import { firstBadResult, forbiddenMetricKeys, metricNames, resourceAttrValues } from "./verify.js";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

interface Received extends OtlpCapture {
  headers: IncomingHttpHeaders;
}

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

/** OTLP/HTTP receiver for what the templates' otlphttp exporters send
 * by default: protobuf, gzip-compressed. Bodies are decoded into the
 * OTLP JSON shape, so the verify.ts helpers apply to them. */
async function startProtoSink() {
  const received: Received[] = [];
  const server = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = req.url ?? "";
      let body: unknown;
      try {
        const raw = Buffer.concat(chunks);
        const pb = req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw;
        body = path === "/v1/metrics" ? metricsJson(pb) : path === "/v1/logs" ? logsJson(pb) : pb;
      } catch (e) {
        body = `undecodable: ${(e as Error).message}`;
      }
      received.push({ path, body, headers: req.headers });
      // An empty Export*ServiceResponse is a full success.
      res.writeHead(200, { "content-type": "application/x-protobuf" }).end();
    });
  });
  return { ...server, received: () => [...received] };
}

/** The length-delimited fields numbered `n` in one protobuf message —
 * submessages and strings; other wire types are skipped. Field numbers
 * below are opentelemetry-proto's. */
function fieldsOf(buf: Buffer, n: number): Buffer[] {
  const out: Buffer[] = [];
  let i = 0;
  const varint = () => {
    let v = 0;
    for (let shift = 0; ; shift += 7) {
      const b = buf[i++];
      if (b === undefined) throw new Error("truncated varint");
      v += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return v;
    }
  };
  while (i < buf.length) {
    const key = varint();
    const wire = key % 8;
    if (wire === 0) varint();
    else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else if (wire === 2) {
      const len = varint();
      if (i + len > buf.length) throw new Error("truncated field");
      if (Math.floor(key / 8) === n) out.push(buf.subarray(i, i + len));
      i += len;
    } else throw new Error(`unsupported wire type ${wire}`);
  }
  return out;
}

const EMPTY = Buffer.alloc(0);
const first = (buf: Buffer, n: number) => fieldsOf(buf, n)[0] ?? EMPTY;
const text = (buf: Buffer, n: number) => fieldsOf(buf, n)[0]?.toString("utf8");

/** KeyValue list → OTLP JSON attributes; string values only, which is
 * all the checks read. */
function attributes(buf: Buffer, n: number) {
  return fieldsOf(buf, n).map((kv) => {
    const s = text(first(kv, 2), 1); // AnyValue.string_value
    return {
      key: text(kv, 1),
      value: s === undefined ? {} : { stringValue: s },
    };
  });
}

/** Metric data field → the attributes field of its datapoints. */
const POINTS = {
  gauge: [5, 7],
  sum: [7, 7],
  histogram: [9, 9],
  exponentialHistogram: [10, 1],
  summary: [11, 7],
} as const;

function metricsJson(req: Buffer) {
  return {
    resourceMetrics: fieldsOf(req, 1).map((rm) => ({
      resource: { attributes: attributes(first(rm, 1), 1) },
      scopeMetrics: fieldsOf(rm, 2).map((sm) => ({
        scope: {
          name: text(first(sm, 1), 1),
          attributes: attributes(first(sm, 1), 3),
        },
        metrics: fieldsOf(sm, 2).map((m) => {
          const metric: Record<string, unknown> = { name: text(m, 1) };
          for (const [kind, [data, attrs]] of Object.entries(POINTS)) {
            for (const d of fieldsOf(m, data)) {
              metric[kind] = {
                dataPoints: fieldsOf(d, 1).map((p) => ({
                  attributes: attributes(p, attrs),
                })),
              };
            }
          }
          return metric;
        }),
      })),
    })),
  };
}

function logsJson(req: Buffer) {
  return {
    resourceLogs: fieldsOf(req, 1).map((rl) => ({
      resource: { attributes: attributes(first(rl, 1), 1) },
      scopeLogs: fieldsOf(rl, 2).map((sl) => ({
        logRecords: fieldsOf(sl, 2).map((r) => ({
          attributes: attributes(r, 6),
        })),
      })),
    })),
  };
}

type Attrs = { key?: string; value: { stringValue?: string } }[];

/** Attribute keys of the hostile metric at each level, as received. */
function hostileLevels(captures: OtlpCapture[]) {
  const keys = (a: Attrs) => a.map((x) => x.key).sort();
  for (const c of captures) {
    if (c.path !== "/v1/metrics") continue;
    const body = c.body as ReturnType<typeof metricsJson>;
    for (const rm of body.resourceMetrics ?? []) {
      for (const sm of rm.scopeMetrics) {
        for (const m of sm.metrics) {
          if (m.name !== "sim.app.hostile_gauge") continue;
          const points = (m.gauge as { dataPoints: { attributes: Attrs }[] }).dataPoints;
          return {
            resource: keys(rm.resource.attributes),
            scope: keys(sm.scope.attributes),
            datapoint: points.flatMap((p) => keys(p.attributes)),
          };
        }
      }
    }
  }
  return undefined;
}

/** One sim lifecycle with the shipped `template` rendered by the agent. */
async function runTemplate(template: string, agentEnv: Record<string, string>): Promise<void> {
  const sim = await startSim({
    agentBin,
    testAppPath,
    suspendCycles: 1,
    agentEnv: {
      KAGERO_COLLECTOR_CONFIG_TEMPLATE: join(repo, template),
      KAGERO_COLLECTOR_ARGS: JSON.stringify([
        "--config",
        "{config}",
        "--set=service::telemetry::metrics::level=none",
        "--set=receivers::otlp::protocols::grpc::endpoint=127.0.0.1:0",
      ]),
      KAGERO_MICROVM_IMAGE_NAME: "sim-image",
      ...agentEnv,
    },
  });
  try {
    const res = await sim.run();
    expect(firstBadResult(res.lifecycle.results)).toBeNull();
  } finally {
    await sim.teardown();
  }
}

/** The ADR-008 contract at the receiver: the hostile metric arrived,
 * with its harmless `sim.level` at each level and no forbidden key on
 * any metric. */
function expectStripped(captures: OtlpCapture[]) {
  const undecodable = captures.filter((c) => typeof c.body === "string");
  expect(undecodable.map((c) => c.body)).toEqual([]);
  expect(metricNames(captures)).toContain("sim.app.hostile_gauge");
  expect(metricNames(captures)).toContain("kagero.microvm.lifecycle_transitions");
  const levels = hostileLevels(captures);
  expect(levels?.resource).toContain("sim.level");
  expect(levels?.scope).toEqual(["sim.level"]);
  expect(levels?.datapoint).toEqual(["sim.level"]);
  expect(forbiddenMetricKeys(captures)).toEqual([]);
  // Logs keep the full identity (ADR-008 restricts metrics only).
  expect(resourceAttrValues(captures, "/v1/logs", "kagero.tenant.id")).toContain("tenant-a");
}

const collectorBin = process.env.KAGERO_SIM_COLLECTOR_BIN;

describe.skipIf(!collectorBin)("shipped collector templates in the real collector", () => {
  it("collector/lgtm strips forbidden ids at resource, scope and datapoint level", {
    timeout: 120_000,
  }, async () => {
    const sink = await startProtoSink();
    // Container credentials and Secrets Manager for the agent's /run
    // secret fetch; the basicauth extension needs the secret's keys.
    // Nothing here checks the SigV4 signature.
    const aws = await listen((req, res) => {
      req.resume();
      req.on("end", () => {
        const reply =
          req.method === "GET" && req.url === "/creds"
            ? { AccessKeyId: "AKIDSIM", SecretAccessKey: "sim", Token: "sim" }
            : req.headers["x-amz-target"] === "secretsmanager.GetSecretValue"
              ? {
                  SecretString: JSON.stringify({
                    username: "sim-user",
                    password: "sim-pass",
                  }),
                }
              : undefined;
        res
          .writeHead(reply ? 200 : 404, {
            "content-type": "application/json",
          })
          .end(JSON.stringify(reply ?? {}));
      });
    });
    try {
      await runTemplate("collector/lgtm/collector.yaml.tmpl", {
        KAGERO_OTLP_ENDPOINT_LGTM: sink.url,
        KAGERO_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:kagero-sim",
        KAGERO_SECRETS_ENDPOINT: aws.url,
        AWS_CONTAINER_CREDENTIALS_FULL_URI: `${aws.url}/creds`,
      });
      const captures = sink.received();
      expectStripped(captures);
      // The fetched secret reached the rendered basicauth extension.
      const basic = `Basic ${Buffer.from("sim-user:sim-pass").toString("base64")}`;
      expect(new Set(captures.map((c) => c.headers.authorization))).toEqual(new Set([basic]));
    } finally {
      await sink.close();
      await aws.close();
    }
  });

  it("collector/cloudwatch strips forbidden ids at resource, scope and datapoint level", {
    timeout: 120_000,
  }, async () => {
    const sink = await startProtoSink();
    try {
      await runTemplate("collector/cloudwatch/collector.yaml.tmpl", {
        KAGERO_BACKEND: "cloudwatch",
        KAGERO_AWS_REGION: "us-east-1",
        KAGERO_ENDPOINT_CW_METRICS: sink.url,
        KAGERO_ENDPOINT_CW_LOGS: sink.url,
        KAGERO_ENDPOINT_CW_TRACES: sink.url,
        // Static keys for the collector's sigv4auth. The receiver does
        // not verify the signature, only its scope.
        AWS_ACCESS_KEY_ID: "AKIDSIM",
        AWS_SECRET_ACCESS_KEY: "sim",
        AWS_SESSION_TOKEN: "sim",
      });
      const captures = sink.received();
      expectStripped(captures);
      // Each signal signs for its own SigV4 service.
      const scope = (path: string) =>
        new Set(
          captures
            .filter((c) => c.path === path)
            .map(
              (c) =>
                /Credential=AKIDSIM\/\d{8}\/([^/]+\/[^/]+)\//.exec(
                  String(c.headers.authorization),
                )?.[1],
            ),
        );
      expect(scope("/v1/metrics")).toEqual(new Set(["us-east-1/monitoring"]));
      expect(scope("/v1/logs")).toEqual(new Set(["us-east-1/logs"]));
      const logs = captures.filter((c) => c.path === "/v1/logs");
      expect(new Set(logs.map((c) => c.headers["x-aws-log-group"]))).toEqual(
        new Set(["/kagero/sim-image"]),
      );
    } finally {
      await sink.close();
    }
  });
});
