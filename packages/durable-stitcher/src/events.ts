/**
 * EventBridge notification parsing (functions-durable-k6.md §2-2).
 * Verified against docs.aws.amazon.com/lambda/latest/dg/durable-monitoring.html:
 * source "aws.lambda", detail-type "Durable Execution Status Change",
 * detail carries durableExecutionArn / durableExecutionName / functionArn /
 * status (RUNNING|SUCCEEDED|STOPPED|FAILED|TIMED_OUT) / startTimestamp /
 * endTimestamp (terminal only). Only fields the pipeline consumes are
 * surfaced on the parsed notification.
 */
import type { DurableStatus } from "./model.js";

export interface DurableStateNotification {
  executionArn: string;
  status: DurableStatus;
  name?: string;
  /** ISO timestamp carried on terminal events only. */
  endTimestamp?: string;
}

// Durable execution arns have a path suffix; the partition is not
// always "aws" (aws-us-gov / aws-cn exist):
// arn:aws:lambda:R:ACCT:function:NAME:VERSION/durable-execution/ID/ID
const DURABLE_ARN_RE =
  /^arn:aws[a-z0-9-]*:lambda:[a-z0-9-]+:\d{12}:function:[\w-]+:[^\s/]+\/durable-execution\/[\w-]+\/[\w-]+$/;

// Only the documented vocabulary is accepted — guessing synonyms would
// silently misclassify a status AWS has not defined.
function normStatus(raw: unknown): DurableStatus | undefined {
  const v = String(raw ?? "").toLowerCase();
  if (v === "succeeded") return "succeeded";
  if (v === "failed") return "failed";
  if (v === "timed_out") return "timed_out";
  if (v === "stopped") return "stopped";
  if (v === "running") return "running";
  return undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse an EventBridge durable-execution status-change event. Throws on
 * malformed input — the caller decides whether to drop or dead-letter.
 */
export function parseEventBridge(raw: unknown): DurableStateNotification {
  if (!isRecord(raw)) throw new Error("event is not an object");
  if (!isRecord(raw.detail)) throw new Error("event.detail is missing");
  const d = raw.detail;

  const arn = d.durableExecutionArn ?? d.executionArn;
  if (typeof arn !== "string" || !DURABLE_ARN_RE.test(arn)) {
    throw new Error("event.detail.durableExecutionArn is missing or not a durable execution ARN");
  }
  const status = normStatus(d.status);
  if (!status) throw new Error(`event.detail.status is missing or unknown: ${String(d.status)}`);

  const out: DurableStateNotification = { executionArn: arn, status };
  const name = d.durableExecutionName ?? d.name;
  if (typeof name === "string" && name) out.name = name;
  if (typeof d.endTimestamp === "string") out.endTimestamp = d.endTimestamp;
  return out;
}
