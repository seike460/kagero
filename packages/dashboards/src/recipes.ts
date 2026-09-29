/**
 * Named log recipes (architecture.md §7 — max 15). A recipe is a NAME
 * plus a per-backend query string. `null` means "this backend cannot
 * express it" — the panel then renders as a text panel marked
 * 非対応 instead of silently disappearing (ADR-010).
 *
 * Field spellings follow what the agent actually emits and what the
 * collector stamps:
 *  - Logs: the agent's log bodies are the literals below
 *    (`kagero.usage.summary`, `kagero.lifecycle.<event>`); the facts are
 *    logRecord ATTRIBUTES — body text matching (`|=`) is used so no
 *    label cardinality is introduced. `service.name=kagero` is stamped
 *    by the collector (identity.rs), so Loki gives `service_name="kagero"`.
 *  - CloudWatch: Logs Insights (CWLI) on the /kagero/<image> log groups
 *    written by collector/cloudwatch headers. PoC-05 verifies the exact
 *    field layout CloudWatch indexes.
 */
export interface RecipeSet {
  /** LogQL (LGTM) — null if unsupported. */
  lgtmLog: string | null;
  /** Logs Insights CWLI (CloudWatch) — null if unsupported. */
  cwLog: string | null;
  /**
   * CloudWatch log-group variable for this recipe — defaults to
   * `$KAGERO_LOG_GROUP` (the collector's /kagero/<image> group).
   * Platform-fallback logs live in the VM's own log group instead.
   */
  cwLogGroup?: string;
}

const AGENT = '{service_name="kagero"}';

export const RECIPES: Record<string, RecipeSet> = {
  /** Usage summary logs emitted on suspend/terminate
   *  (body "kagero.usage.summary", facts on logRecord attributes). */
  "usage-summary": {
    lgtmLog: `${AGENT} |= "kagero.usage.summary" | json`,
    cwLog:
      "fields @timestamp, @message\n| filter @message like /kagero.usage.summary/\n| sort @timestamp desc\n| limit 200",
  },
  /** Degraded-path events — fail-soft kagero-side failures (e.g. secret
   *  fetch, collector, OTLP export; app relay failures are not degraded)
   *  (body "kagero.lifecycle.degraded", reason on attributes). When the
   *  collector itself is down, these never arrive here — use
   *  platform-degraded on CloudWatch for the stdout fallback. */
  "lifecycle-degraded": {
    lgtmLog: `${AGENT} |= "kagero.lifecycle.degraded" | json`,
    cwLog:
      "fields @timestamp, @message\n| filter @message like /kagero.lifecycle.degraded/\n| sort @timestamp desc\n| limit 200",
  },
  /** Stdout fallback: the agent always writes degraded events to stdout,
   *  which lands in the MicroVM's own platform log group — the only copy
   *  that survives when the collector path is down. CloudWatch-only:
   *  on LGTM, stdout has no route into Loki (非対応). */
  "platform-degraded": {
    lgtmLog: null,
    cwLog:
      "fields @timestamp, @message\n| filter @message like /kagero.lifecycle.degraded/\n| sort @timestamp desc\n| limit 200",
    cwLogGroup: "$KAGERO_PLATFORM_LOG_GROUP",
  },
  /** Lifecycle traces for one MicroVM. UNIMPLEMENTED on both backends:
   *  the agent does not emit spans yet (no /v1/traces traffic). */
  "microvm-traces": {
    lgtmLog: null,
    cwLog: null,
  },
};
