/**
 * Backend adapters (architecture.md §7). Each adapter owns: datasource
 * references, OTel→selector conversion exceptions, recipe → dataquery
 * mapping, and the capability matrix. Unsupported pieces return null —
 * the builder turns that into a 非対応 text panel.
 */

import * as cloudwatch from "@grafana/grafana-foundation-sdk/cloudwatch";
import type * as cog from "@grafana/grafana-foundation-sdk/cog";
import type * as dashboard from "@grafana/grafana-foundation-sdk/dashboard";
import * as loki from "@grafana/grafana-foundation-sdk/loki";
import { type MetricNamer, makeNamer, OTLP_TOTAL_EXCEPTIONS } from "./otel-names.js";
import { RECIPES } from "./recipes.js";

export type Backend = "lgtm" | "cloudwatch";

export interface BackendAdapter {
  id: Backend;
  /** OTel name → backend selector. */
  metric: MetricNamer;
  metricDs: dashboard.DataSourceRef;
  logDs: dashboard.DataSourceRef | null;
  /** Query builders per recipe — null when unsupported here. */
  logQuery(recipe: string, refId: string): cog.Builder<cog.Dataquery> | null;
  /**
   * Datasource template variables to emit — the `${DS_*}` uids used in
   * panel datasource refs resolve through these pickers on import, so
   * the dashboard works without editing the JSON.
   */
  datasourceVars: { name: string; label: string; pluginType: string }[];
  /**
   * Backend-scoped free-text variables (e.g. the CloudWatch log groups
   * recipes query). LGTM emits none — these names only exist in CWLI
   * recipes, so emitting them on LGTM would present dead inputs.
   */
  textVars?: { name: string; label: string; value: string }[];
}

// Datasource variable names the generated JSON references — each is a
// datasource-type template variable (see datasourceVars) so the picker
// resolves the uid on import.
const dsVar = (name: string) => `$\{${name}}`;
const LGTM_PROM_DS: dashboard.DataSourceRef = { type: "prometheus", uid: dsVar("DS_PROMETHEUS") };
const LGTM_LOKI_DS: dashboard.DataSourceRef = { type: "loki", uid: dsVar("DS_LOKI") };
// CloudWatch OTLP metrics are queried with PromQL via the Amazon Managed
// Service for Prometheus datasource plugin (AWS docs "Query CloudWatch
// metrics with PromQL in Grafana"), not the core prometheus plugin.
const AMP_DS_TYPE = "grafana-amazonprometheus-datasource";
const CW_PROM_DS: dashboard.DataSourceRef = { type: AMP_DS_TYPE, uid: dsVar("DS_CW_PROM") };
const CW_PLUGIN_DS: dashboard.DataSourceRef = { type: "cloudwatch", uid: dsVar("DS_CLOUDWATCH") };

export const lgtmAdapter: BackendAdapter = {
  id: "lgtm",
  // Mimir applies UnderscoreEscapingWithSuffixes on OTLP ingest —
  // monotonic sums surface as <name>_total (otel-names.ts).
  metric: makeNamer(OTLP_TOTAL_EXCEPTIONS),
  metricDs: LGTM_PROM_DS,
  logDs: LGTM_LOKI_DS,
  logQuery(recipe, refId) {
    const q = RECIPES[recipe]?.lgtmLog;
    if (!q) return null;
    return new loki.DataqueryBuilder().expr(q).refId(refId).datasource(LGTM_LOKI_DS);
  },
  datasourceVars: [
    { name: "DS_PROMETHEUS", label: "Metrics (Prometheus)", pluginType: "prometheus" },
    { name: "DS_LOKI", label: "Logs (Loki)", pluginType: "loki" },
  ],
};

export const cloudwatchAdapter: BackendAdapter = {
  id: "cloudwatch",
  // CloudWatch's OTLP→PromQL surface applies the same counter suffixing;
  // PoC-06 verifies the exact spelling on the real endpoint.
  metric: makeNamer(OTLP_TOTAL_EXCEPTIONS),
  metricDs: CW_PROM_DS,
  logDs: CW_PLUGIN_DS,
  logQuery(recipe, refId) {
    const r = RECIPES[recipe];
    const q = r?.cwLog;
    if (!q) return null;
    return (
      new cloudwatch.CloudWatchLogsQueryBuilder()
        .queryMode(cloudwatch.CloudWatchQueryMode.Logs)
        .queryLanguage(cloudwatch.LogsQueryLanguage.CWLI)
        .expression(q)
        // Default log group is /kagero/<image-name> (collector cloudwatch
        // template); recipes may override it (e.g. the platform group for
        // the stdout fallback path).
        .logGroupNames([r?.cwLogGroup ?? "$KAGERO_LOG_GROUP"])
        .region("default")
        .refId(refId)
        .datasource(CW_PLUGIN_DS)
    );
  },
  datasourceVars: [
    // AMP plugin — CW OTLP metrics PromQL surface (see AMP_DS_TYPE).
    { name: "DS_CW_PROM", label: "Metrics (PromQL)", pluginType: AMP_DS_TYPE },
    { name: "DS_CLOUDWATCH", label: "CloudWatch", pluginType: "cloudwatch" },
  ],
  // CWLI recipes interpolate these; LGTM has no equivalent inputs.
  textVars: [
    {
      name: "KAGERO_LOG_GROUP",
      label: "CloudWatch log group",
      value: "/kagero/<image-name>",
    },
    {
      name: "KAGERO_PLATFORM_LOG_GROUP",
      label: "MicroVM platform log group",
      value: "/aws/lambda/<function-name>",
    },
  ],
};

export function adapterFor(backend: Backend): BackendAdapter {
  return backend === "lgtm" ? lgtmAdapter : cloudwatchAdapter;
}
