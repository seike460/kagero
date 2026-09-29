import { METRIC_LABEL_FORBIDDEN } from "@kagero/semconv";
import { describe, expect, it } from "vitest";
import { adapterFor } from "./adapters.js";
import { buildAlertOutput, buildPromRuleFile } from "./alerts.js";
import { buildDashboard, dashboardJson } from "./build.js";
import { assertSafeSelector, promName } from "./otel-names.js";
import { microvmOverview } from "./spec.js";

interface Panel {
  type?: string;
  title?: string;
  targets?: { expr?: string; datasource?: { type?: string; uid?: string } }[];
  gridPos?: { y?: number };
  datasource?: { type?: string; uid?: string };
}

interface Dashboard {
  uid?: string;
  title?: string;
  refresh?: string;
  panels?: (Panel | { type: "row"; title?: string; collapsed?: boolean })[];
}

/** Minimal PromQL sanity: balanced (){}[], no empty selector body. */
function lintPromql(expr: string): string[] {
  const errors: string[] = [];
  const stack: string[] = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  let inString = false;
  for (const ch of expr) {
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if ("([{".includes(ch)) stack.push(ch);
    if (")]}".includes(ch)) {
      const open = stack.pop();
      if (open !== pairs[ch]) errors.push(`unbalanced ${ch} in ${expr}`);
    }
  }
  if (stack.length) errors.push(`unclosed ${stack.join("")} in ${expr}`);
  if (/=\s*[,}]/u.test(expr) || /\{\s*\}/u.test(expr)) {
    errors.push(`empty matcher/selector in ${expr}`);
  }
  return errors;
}

function flatPanels(d: Dashboard): Panel[] {
  return (d.panels ?? []).filter((p): p is Panel => (p as Panel).type !== "row");
}

describe("buildDashboard", () => {
  for (const backend of ["lgtm", "cloudwatch"] as const) {
    it(`produces v1 dashboard JSON for ${backend}`, () => {
      const d = JSON.parse(dashboardJson(microvmOverview, adapterFor(backend))) as Dashboard;
      expect(d.uid).toBe(`kagero-microvm-overview-${backend}`);
      expect(d.title).toContain("MicroVM");
      expect(d.refresh).toBe("1m"); // query-cost rule: >=1m
      expect(flatPanels(d).length).toBeGreaterThan(5);
    });
  }

  it("keeps every metric query PromQL-sane and forbidden-label-free", () => {
    for (const backend of ["lgtm", "cloudwatch"] as const) {
      const d = buildDashboard(microvmOverview, adapterFor(backend)) as Dashboard;
      for (const p of flatPanels(d)) {
        for (const t of p.targets ?? []) {
          if (!t.expr) continue;
          expect(lintPromql(t.expr), `${backend}/${p.title}: ${t.expr}`).toEqual([]);
          for (const key of METRIC_LABEL_FORBIDDEN) {
            expect(t.expr).not.toContain(key);
            expect(t.expr).not.toContain(promName(key));
          }
        }
      }
    }
  });

  it("renders traces as 非対応 text panels on BOTH backends (no spans yet)", () => {
    for (const backend of ["lgtm", "cloudwatch"] as const) {
      const d = buildDashboard(microvmOverview, adapterFor(backend)) as Dashboard;
      const trace = flatPanels(d).find((p) => p.title?.includes("lifecycle traces"));
      expect(trace?.type).toBe("text");
      expect(trace?.title).toContain("非対応");
    }
  });

  it("log panels use the core 'logs' type and backend-appropriate queries", () => {
    const lgtm = buildDashboard(microvmOverview, adapterFor("lgtm")) as Dashboard;
    const cw = buildDashboard(microvmOverview, adapterFor("cloudwatch")) as Dashboard;
    const lgtmLogs = flatPanels(lgtm).filter((p) => p.type === "logs");
    // 2 queryable log panels + the platform-fallback panel, which is
    // 非対応 (text) on LGTM — stdout never reaches Loki.
    expect(lgtmLogs.length).toBe(2);
    for (const p of lgtmLogs) {
      expect(p.datasource?.type).toBe("loki");
      for (const t of p.targets ?? []) {
        expect(t.expr).toContain('service_name="kagero"');
        expect(t.expr).toMatch(/kagero\.(usage\.summary|lifecycle\.degraded)/);
      }
    }
    // CloudWatch Logs panels live inside the collapsed row's panels.
    const cwRows = (cw.panels ?? []).filter(
      (p): p is { type: "row"; title?: string; panels?: Panel[]; collapsed?: boolean } =>
        p.type === "row",
    );
    const logRow = cwRows.find((r) => r.title === "Logs");
    expect(logRow?.collapsed).toBe(true);
    const cwLogs = (logRow?.panels ?? []).filter((p) => p.type === "logs");
    expect(cwLogs.length).toBe(3);
    const groups = new Set<string>();
    for (const p of cwLogs) {
      expect(p.datasource?.type).toBe("cloudwatch");
      for (const t of (p.targets ?? []) as { expression?: string; logGroupNames?: string[] }[]) {
        expect(t.expression).toMatch(/kagero\.(usage\.summary|lifecycle\.degraded)/);
        for (const g of t.logGroupNames ?? []) groups.add(g);
      }
    }
    // Collector group AND the platform-fallback group must both appear.
    expect(groups).toEqual(new Set(["$KAGERO_LOG_GROUP", "$KAGERO_PLATFORM_LOG_GROUP"]));
  });

  it("gives each backend a distinct uid", () => {
    const lgtm = buildDashboard(microvmOverview, adapterFor("lgtm")) as Dashboard;
    const cw = buildDashboard(microvmOverview, adapterFor("cloudwatch")) as Dashboard;
    expect(lgtm.uid).toBe("kagero-microvm-overview-lgtm");
    expect(cw.uid).toBe("kagero-microvm-overview-cloudwatch");
  });

  it("points metric panels at the right metrics datasource per backend", () => {
    // LGTM uses the core prometheus datasource; CloudWatch OTLP metrics
    // are queried through the AMP plugin (grafana-amazonprometheus-
    // datasource) per AWS's PromQL-in-Grafana docs.
    const expected = {
      lgtm: "prometheus",
      cloudwatch: "grafana-amazonprometheus-datasource",
    } as const;
    for (const backend of ["lgtm", "cloudwatch"] as const) {
      const d = buildDashboard(microvmOverview, adapterFor(backend)) as Dashboard;
      const metricPanels = flatPanels(d).filter((p) =>
        (p.targets ?? []).some((t) => t.expr?.includes("kagero_microvm_")),
      );
      expect(metricPanels.length).toBeGreaterThan(2);
      for (const p of metricPanels) {
        for (const t of p.targets ?? []) {
          expect(t.datasource?.type).toBe(expected[backend]);
        }
      }
    }
  });

  it("collapses the Logs row on cloudwatch only, with panels INSIDE it", () => {
    const lgtm = buildDashboard(microvmOverview, adapterFor("lgtm")) as Dashboard;
    const cw = buildDashboard(microvmOverview, adapterFor("cloudwatch")) as Dashboard;
    const rows = (d: Dashboard) =>
      (d.panels ?? []).filter(
        (p): p is { type: "row"; title?: string; collapsed?: boolean } => p.type === "row",
      );
    expect(rows(lgtm).find((r) => r.title === "Logs")?.collapsed).toBe(false);
    const cwLogRow = rows(cw).find((r) => r.title === "Logs");
    expect(cwLogRow?.collapsed).toBe(true);
    // v1: collapsed row must own its panels or they still render+query.
    expect((cwLogRow as { panels?: unknown[] }).panels?.length).toBe(3);
  });

  it("defaults the cloudwatch log-group variables to the collector and MicroVM groups", () => {
    const cw = buildDashboard(microvmOverview, adapterFor("cloudwatch")) as {
      templating?: { list?: { name?: string; query?: unknown }[] };
    };
    const vars = new Map((cw.templating?.list ?? []).map((v) => [v.name, v.query]));
    expect(vars.get("KAGERO_LOG_GROUP")).toBe("/kagero/<image-name>");
    // AWS default for MicroVM build/runtime stdout — not a function's /aws/lambda/<name>.
    expect(vars.get("KAGERO_PLATFORM_LOG_GROUP")).toBe("/aws/lambda-microvms/<image-name>");
  });
});

describe("buildAlerts", () => {
  it("emits a strict Prometheus rule file for lgtm (groups only)", () => {
    const f = buildPromRuleFile(adapterFor("lgtm"));
    expect(Object.keys(f).sort()).toEqual(["groups"]);
    for (const r of f.groups[0]?.rules ?? []) {
      expect(lintPromql(r.expr)).toEqual([]);
      for (const key of METRIC_LABEL_FORBIDDEN) {
        expect(r.expr).not.toContain(promName(key));
      }
    }
  });
  it("emits an unsupported manifest for cloudwatch (alarms via CDK)", () => {
    const f = buildAlertOutput(adapterFor("cloudwatch")) as {
      backend: string;
      note?: string;
      rules: { supported: boolean; unsupportedReason?: string }[];
    };
    expect(f.backend).toBe("cloudwatch");
    expect(f.note).toBeTruthy();
    for (const r of f.rules) {
      expect(r.supported).toBe(false);
      expect(r.unsupportedReason).toMatch(/CDK|PromQL/);
    }
  });
});

describe("assertSafeSelector", () => {
  it("rejects forbidden labels in both spellings", () => {
    expect(() => assertSafeSelector('x{kagero_tenant_id="t"}')).toThrow(/forbidden/);
    expect(() => assertSafeSelector('x{"kagero.tenant.id"="t"}')).toThrow(/forbidden/);
    // The metric NAME kagero_microvm_suspend_duration_seconds must not
    // trip the kagero.suspend.duration_seconds label check.
    expect(
      assertSafeSelector("rate(kagero_microvm_suspend_duration_seconds_bucket[5m])"),
    ).toBeTruthy();
  });
});
