import { describe, expect, it } from "vitest";
import type { OtlpCapture } from "./mock-otlp.js";
import {
  forbiddenMetricKeys,
  hookStatuses,
  metricAttrKeys,
  nonMonotonicSumNames,
} from "./verify.js";

const cap = (body: unknown): OtlpCapture => ({ path: "/v1/metrics", body });

describe("forbiddenMetricKeys", () => {
  it("detects forbidden attrs at resource, scope, AND datapoint level", () => {
    const bad = cap({
      resourceMetrics: [
        {
          resource: { attributes: [{ key: "service.instance.id", value: { stringValue: "m1" } }] },
          scopeMetrics: [
            {
              scope: {
                name: "app",
                attributes: [{ key: "kagero.tenant.id", value: { stringValue: "t" } }],
              },
              metrics: [
                {
                  name: "x",
                  sum: {
                    aggregationTemporality: 2,
                    isMonotonic: true,
                    dataPoints: [
                      {
                        asInt: "1",
                        attributes: [{ key: "faas.instance", value: { stringValue: "i" } }],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(forbiddenMetricKeys([bad]).sort()).toEqual(
      ["faas.instance", "kagero.tenant.id", "service.instance.id"].sort(),
    );
  });

  it("ignores non-metrics payloads and clean metrics", () => {
    const clean = cap({
      resourceMetrics: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "kagero" } }] },
          scopeMetrics: [
            {
              scope: { name: "kagero-agent" },
              metrics: [
                {
                  name: "x",
                  sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: [] },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(forbiddenMetricKeys([clean])).toEqual([]);
    expect(forbiddenMetricKeys([{ path: "/v1/logs", body: { resourceLogs: [] } }])).toEqual([]);
  });
});

describe("nonMonotonicSumNames", () => {
  it("flags delta or non-monotonic sums, keeps cumulative monotonic", () => {
    const mk = (temporality: number, isMonotonic: boolean, name: string) =>
      cap({
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: [{ name, sum: { aggregationTemporality: temporality, isMonotonic } }],
              },
            ],
          },
        ],
      });
    const captures = [mk(1, true, "delta_sum"), mk(2, false, "nonmono_sum"), mk(2, true, "ok_sum")];
    expect(nonMonotonicSumNames(captures).sort()).toEqual(["delta_sum", "nonmono_sum"]);
  });
});

describe("metricAttrKeys", () => {
  it("collects keys from all three attribute levels", () => {
    const keys = metricAttrKeys(
      cap({
        resourceMetrics: [
          {
            resource: { attributes: [{ key: "a" }] },
            scopeMetrics: [
              {
                scope: { attributes: [{ key: "b" }] },
                metrics: [{ name: "m", sum: { dataPoints: [{ attributes: [{ key: "c" }] }] } }],
              },
            ],
          },
        ],
      }).body,
    );
    expect(keys.sort()).toEqual(["a", "b", "c"]);
  });

  it("reads the datapoints of every metric data kind", () => {
    const metric = (kind: string, key: string) => ({
      name: key,
      [kind]: { dataPoints: [{ attributes: [{ key }] }] },
    });
    const keys = metricAttrKeys({
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                metric("gauge", "g"),
                metric("histogram", "h"),
                metric("exponentialHistogram", "e"),
                metric("summary", "s"),
              ],
            },
          ],
        },
      ],
    });
    expect(keys.sort()).toEqual(["e", "g", "h", "s"]);
  });
});

describe("hookStatuses", () => {
  it("returns the status of each hook-result datapoint for one hook", () => {
    const point = (hook: string, status: string) => ({
      attributes: [
        { key: "kagero.hook.name", value: { stringValue: hook } },
        { key: "kagero.hook.status", value: { stringValue: status } },
      ],
    });
    const metric = (name: string, ...dataPoints: unknown[]) =>
      cap({ resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name, sum: { dataPoints } }] }] }] });
    const captures = [
      metric("kagero.microvm.hook_results", point("suspend", "unimplemented")),
      metric("kagero.microvm.hook_results", point("resume", "ok"), point("suspend", "timeout")),
      metric("other", point("suspend", "error")),
    ];
    expect(hookStatuses(captures, "suspend")).toEqual(["unimplemented", "timeout"]);
    expect(hookStatuses(captures, "resume")).toEqual(["ok"]);
    expect(hookStatuses(captures, "run")).toEqual([]);
  });
});
