import { describe, expect, it } from "vitest";
import { callHook, HOOK_PATH, runBody } from "./hooks.js";
import { startMockOtlp } from "./mock-otlp.js";
import {
  forbiddenMetricKeys,
  isAppHookLog,
  isLifecycle,
  metricAttrKeys,
  metricNames,
} from "./verify.js";

describe("callHook", () => {
  it("posts to the runtime hook path", async () => {
    const seen: string[] = [];
    const { createServer } = await import("node:http");
    const srv = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    const r = await callHook(`http://127.0.0.1:${port}`, "run", { a: 1 }, 2000);
    expect(r.status).toBe(200);
    expect(seen[0]).toBe(`POST ${HOOK_PATH}run`);
    srv.close();
  });
});

describe("mock otlp + verify helpers", () => {
  it("captures payloads and finds forbidden metric attrs", async () => {
    const otlp = await startMockOtlp(0);
    try {
      const metricPayload = {
        resourceMetrics: [
          {
            resource: {
              attributes: [{ key: "service.instance.id", value: { stringValue: "mvm" } }],
            },
            scopeMetrics: [
              {
                scope: {
                  attributes: [{ key: "kagero.session.id", value: { stringValue: "sess" } }],
                },
                metrics: [
                  {
                    name: "x",
                    sum: {
                      dataPoints: [
                        { attributes: [{ key: "kagero.tenant.id", value: { stringValue: "t" } }] },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      };
      await fetch(`${otlp.url}/v1/metrics`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(metricPayload),
      });
      const caps = otlp.captures();
      expect(caps).toHaveLength(1);
      expect(metricAttrKeys(caps.at(0)?.body)).toContain("service.instance.id");
      expect(metricAttrKeys(caps.at(0)?.body)).toContain("kagero.session.id");
      expect(forbiddenMetricKeys(caps).sort()).toEqual([
        "kagero.session.id",
        "kagero.tenant.id",
        "service.instance.id",
      ]);
      expect(metricNames(caps)).toEqual(["x"]);
    } finally {
      await otlp.close();
    }
  });

  it("detects app hook logs and lifecycle captures", async () => {
    const otlp = await startMockOtlp(0);
    try {
      await fetch(`${otlp.url}/v1/logs`, {
        method: "POST",
        body: JSON.stringify({
          resourceLogs: [
            {
              scopeLogs: [
                {
                  logRecords: [
                    { attributes: [{ key: "sim.hook", value: { stringValue: "suspend" } }] },
                  ],
                },
              ],
            },
          ],
        }),
      });
      await fetch(`${otlp.url}/v1/metrics`, {
        method: "POST",
        body: JSON.stringify({
          resourceMetrics: [
            {
              scopeMetrics: [
                {
                  metrics: [
                    {
                      name: "kagero.microvm.lifecycle_transitions",
                      sum: {
                        dataPoints: [
                          {
                            attributes: [
                              { key: "kagero.lifecycle.event", value: { stringValue: "suspend" } },
                            ],
                          },
                        ],
                      },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      });
      const caps = otlp.captures();
      expect(isAppHookLog(caps.at(0), "suspend")).toBe(true);
      expect(isAppHookLog(caps.at(0), "run")).toBe(false);
      expect(isLifecycle(caps.at(1), "suspend")).toBe(true);
      // Exact attribute value match — a substring impl would also pass
      // this (the payload contains no "run"), so pin both directions.
      expect(isLifecycle(caps.at(1), "run")).toBe(false);
      // A /v1/logs capture containing the event word (e.g. a usage
      // summary with cause:"suspend") must NOT count as a lifecycle event.
      expect(isLifecycle(caps.at(0), "suspend")).toBe(false);
    } finally {
      await otlp.close();
    }
  });
});

describe("runBody", () => {
  it("builds the runtime /run shape", () => {
    const b = runBody({ microvmId: "m1", tenantId: "t", sessionId: "s" });
    expect(b.microvmId).toBe("m1");
    expect((b.runHookPayload as { tenant: { id: string } }).tenant.id).toBe("t");
  });
});
