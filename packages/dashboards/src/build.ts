/**
 * spec + adapter → Grafana v1 dashboard JSON (Foundation SDK builders).
 * Unsupported queries/panels become text panels marked 非対応 — panels
 * are never silently dropped (ADR-010).
 */
import type * as cog from "@grafana/grafana-foundation-sdk/cog";
import * as dashboard from "@grafana/grafana-foundation-sdk/dashboard";
import * as logspanel from "@grafana/grafana-foundation-sdk/logs";
import * as prometheus from "@grafana/grafana-foundation-sdk/prometheus";
import * as stat from "@grafana/grafana-foundation-sdk/stat";
import * as text from "@grafana/grafana-foundation-sdk/text";
import * as timeseries from "@grafana/grafana-foundation-sdk/timeseries";
import type { BackendAdapter } from "./adapters.js";
import { assertSafeSelector } from "./otel-names.js";
import type { DashboardSpec, PanelSpec } from "./spec.js";

const REFS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Per-build ref-id generator — refIds only need to be unique within one dashboard. */
function refIdGen(): () => string {
  let seq = 0;
  return () => REFS[seq++ % REFS.length] ?? "Z";
}

function unsupportedPanel(title: string, reason: string, span = 24, height = 6) {
  return new text.PanelBuilder()
    .title(`${title} — 非対応`)
    .content(`**このバックエンドでは非対応です。**\n\n${reason}`)
    .span(span)
    .height(height);
}

function metricPanel(
  panel: PanelSpec,
  targets: cog.Builder<cog.Dataquery>[],
): cog.Builder<dashboard.Panel> {
  const base = panel.kind === "stat" ? new stat.PanelBuilder() : new timeseries.PanelBuilder();
  base
    .title(panel.title)
    .span(panel.span ?? 12)
    .height(panel.height ?? 8);
  if (panel.description) base.description(panel.description);
  if (panel.unit) base.unit(panel.unit);
  for (const t of targets) base.withTarget(t);
  return base;
}

function buildPanel(
  panel: PanelSpec,
  adapter: BackendAdapter,
  refId: () => string,
): cog.Builder<dashboard.Panel> {
  switch (panel.kind) {
    case "text":
      return new text.PanelBuilder()
        .title(panel.title)
        .content(panel.markdown ?? "")
        .span(panel.span ?? 12)
        .height(panel.height ?? 8);
    case "stat":
    case "timeseries": {
      const targets = (panel.metrics ?? []).map((q) => {
        const expr = assertSafeSelector(q.expr(adapter.metric));
        const b = new prometheus.DataqueryBuilder()
          .expr(expr)
          .refId(refId())
          .datasource(adapter.metricDs);
        if (q.legend) b.legendFormat(q.legend);
        return b as cog.Builder<cog.Dataquery>;
      });
      return metricPanel(panel, targets);
    }
    case "logs": {
      if (!adapter.logDs) {
        return unsupportedPanel(
          panel.title,
          "log datasource is not configured for this backend.",
          panel.span,
          panel.height,
        );
      }
      const targets = (panel.recipes ?? []).map((name) => adapter.logQuery(name, refId()));
      if (targets.some((t) => t === null)) {
        const missing = (panel.recipes ?? []).filter((_, i) => targets[i] === null);
        return unsupportedPanel(
          panel.title,
          `recipe(s) not supported on ${adapter.id}: ${missing.join(", ")}`,
          panel.span,
          panel.height,
        );
      }
      const b = new logspanel.PanelBuilder()
        .title(panel.title)
        .span(panel.span ?? 12)
        .height(panel.height ?? 9)
        .datasource(adapter.logDs);
      if (panel.description) b.description(panel.description);
      for (const t of targets as cog.Builder<cog.Dataquery>[]) b.withTarget(t);
      return b;
    }
    case "traces":
      // The agent emits no spans yet — always a 非対応 text panel until
      // span emission lands (honest per ADR-010, on BOTH backends).
      return unsupportedPanel(
        panel.title,
        "the kagero agent does not emit traces yet — no /v1/traces traffic exists to render.",
        panel.span,
        panel.height,
      );
  }
}

export function buildDashboard(spec: DashboardSpec, adapter: BackendAdapter): dashboard.Dashboard {
  const refId = refIdGen();
  const b = new dashboard.DashboardBuilder(spec.title)
    // Per-backend uid — importing both into one org must not collide.
    .uid(`${spec.uid}-${adapter.id}`)
    .tags(spec.tags)
    .refresh(spec.refresh)
    .time({ from: "now-6h", to: "now" })
    .editable();
  if (spec.description) b.description(spec.description);
  for (const v of adapter.datasourceVars) {
    b.withVariable(
      new dashboard.DatasourceVariableBuilder(v.name).label(v.label).type(v.pluginType),
    );
  }
  for (const c of spec.constants) {
    b.withVariable(new dashboard.ConstantVariableBuilder(c.name).label(c.label).value(c.value));
  }
  for (const v of adapter.textVars ?? []) {
    b.withVariable(
      new dashboard.TextBoxVariableBuilder(v.name).label(v.label).defaultValue(v.value),
    );
  }
  for (const row of spec.rows) {
    const collapsed = adapter.id === "cloudwatch" && (row.collapseOnCloudWatch ?? false);
    if (collapsed) {
      // v1 collapse only hides panels INSIDE row.panels — put them there.
      const rb = new dashboard.RowBuilder(row.title).collapsed(true);
      for (const p of row.panels) rb.withPanel(buildPanel(p, adapter, refId));
      b.withRow(rb);
    } else {
      b.withRow(new dashboard.RowBuilder(row.title));
      for (const p of row.panels) {
        b.withPanel(buildPanel(p, adapter, refId));
      }
    }
  }
  return b.build();
}

/** Serialize for generated/ output — stable key order via the SDK's own shape. */
export function dashboardJson(spec: DashboardSpec, adapter: BackendAdapter): string {
  return `${JSON.stringify(buildDashboard(spec, adapter), null, 2)}\n`;
}
