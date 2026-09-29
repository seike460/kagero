/**
 * Trace assembly (functions-durable-k6.md §2-2). One execution → one
 * trace; steps/waits/callbacks/retries are child spans; replay count is
 * a span attribute; IDs are deterministic — the same execution ARN
 * always produces the same trace ID, so a re-assembled trace dedupes.
 */
import { createHash } from "node:crypto";
import {
  ATTR_KAGERO_DURABLE_ATTEMPT,
  ATTR_KAGERO_DURABLE_EXECUTION_ARN,
  ATTR_KAGERO_DURABLE_EXECUTION_NAME,
  ATTR_KAGERO_DURABLE_REPLAY_COUNT,
  ATTR_KAGERO_DURABLE_STATUS,
  ATTR_KAGERO_DURABLE_STEP_KIND,
  ATTR_KAGERO_DURABLE_STEP_NAME,
} from "@kagero/semconv";
import type { DurableStatus, ExecutionEvent, ExecutionRecord, SpanLinkRef } from "./model.js";

// OTLP SpanKind values.
export const SPAN_KIND_INTERNAL = 1;
export const SPAN_KIND_SERVER = 2;
// OTLP Status codes.
export const STATUS_UNSET = 0;
export const STATUS_OK = 1;
export const STATUS_ERROR = 2;

export interface OtlpAttr {
  key: string;
  value: Record<string, unknown>;
}

export interface StitchedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano?: string;
  attributes: OtlpAttr[];
  status: { code: number };
  links?: { traceId: string; spanId: string }[];
}

export interface AssembledTrace {
  /** Deterministic — sha256(executionArn)[0:32]. */
  traceId: string;
  rootSpanId: string;
  spans: StitchedSpan[];
}

function sha(hex: string): string {
  return createHash("sha256").update(hex).digest("hex");
}

/** Deterministic trace id: first 16 bytes of sha256(arn). */
export function traceIdFor(executionArn: string): string {
  return sha(executionArn).slice(0, 32);
}

/** Deterministic span id for a stable key inside a trace. */
export function spanIdFor(traceId: string, key: string): string {
  return sha(`${traceId}/${key}`).slice(0, 16);
}

function eventSpanId(traceId: string, eventId: string): string {
  return spanIdFor(traceId, `event/${eventId}`);
}

function nanos(d: Date): string {
  return `${BigInt(d.getTime()) * 1_000_000n}`;
}

function attrVal(v: string | number | boolean): Record<string, unknown> {
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  }
  return { stringValue: v };
}

function attrs(o: Record<string, string | number | boolean>): OtlpAttr[] {
  return Object.entries(o).map(([key, v]) => ({ key, value: attrVal(v) }));
}

function statusCode(s: DurableStatus): number {
  switch (s) {
    case "succeeded":
      return STATUS_OK;
    case "failed":
    case "timed_out":
    case "stopped":
      return STATUS_ERROR;
    default:
      return STATUS_UNSET;
  }
}

/**
 * Replay count = max(reported replayCount, retry-shaped evidence):
 * retry-kind events plus any event with attempt >= 2.
 */
function replayCount(rec: ExecutionRecord): number {
  const seen = rec.events.filter((e) => e.kind === "retry" || (e.attempt ?? 1) >= 2).length;
  return Math.max(rec.replayCount, seen);
}

function shortArn(arn: string): string {
  const tail = arn.split(":").pop() ?? arn;
  return tail.length > 40 ? `${tail.slice(0, 37)}...` : tail;
}

/**
 * Assemble an execution into OTLP spans. Children are sorted by
 * startTime; a child whose parentId resolves to another event's id is
 * nested, otherwise it hangs on the root span.
 */
export function assembleTrace(rec: ExecutionRecord): AssembledTrace {
  const traceId = traceIdFor(rec.executionArn);
  const rootSpanId = spanIdFor(traceId, "execution");
  const replays = replayCount(rec);

  const end = rec.endTime ?? latestEnd(rec.events) ?? rec.startTime;
  const rootAttrs: OtlpAttr[] = [
    ...attrs({
      [ATTR_KAGERO_DURABLE_EXECUTION_ARN]: rec.executionArn,
      [ATTR_KAGERO_DURABLE_STATUS]: rec.status,
      [ATTR_KAGERO_DURABLE_REPLAY_COUNT]: replays,
    }),
  ];
  if (rec.name)
    rootAttrs.push({ key: ATTR_KAGERO_DURABLE_EXECUTION_NAME, value: attrVal(rec.name) });

  const root: StitchedSpan = {
    traceId,
    spanId: rootSpanId,
    name: rec.name ?? `durable ${shortArn(rec.executionArn)}`,
    kind: SPAN_KIND_SERVER,
    startTimeUnixNano: nanos(rec.startTime),
    endTimeUnixNano: nanos(end),
    attributes: rootAttrs,
    status: { code: statusCode(rec.status) },
  };

  const spanIdByEventId = new Map<string, string>();
  const sorted = [...rec.events].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  for (const e of sorted) spanIdByEventId.set(e.id, eventSpanId(traceId, e.id));

  const children: StitchedSpan[] = sorted.map((e) =>
    childSpan(traceId, rootSpanId, e, spanIdByEventId),
  );
  return { traceId, rootSpanId, spans: [root, ...children] };
}

function childSpan(
  traceId: string,
  rootSpanId: string,
  e: ExecutionEvent,
  spanIdByEventId: Map<string, string>,
): StitchedSpan {
  const a = attrs({
    [ATTR_KAGERO_DURABLE_STEP_KIND]: e.kind,
    [ATTR_KAGERO_DURABLE_STATUS]: e.status,
    ...(e.name ? { [ATTR_KAGERO_DURABLE_STEP_NAME]: e.name } : {}),
    ...(e.attempt !== undefined ? { [ATTR_KAGERO_DURABLE_ATTEMPT]: e.attempt } : {}),
    ...e.attributes,
  });
  const span: StitchedSpan = {
    traceId,
    spanId: eventSpanId(traceId, e.id),
    parentSpanId: (e.parentId && spanIdByEventId.get(e.parentId)) ?? rootSpanId,
    name: e.name ? `${e.kind}: ${e.name}` : e.kind,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: nanos(e.startTime),
    attributes: a,
    status: { code: statusCode(e.status) },
  };
  if (e.endTime) span.endTimeUnixNano = nanos(e.endTime);
  if (e.links?.length) span.links = linksOut(e.links);
  return span;
}

function linksOut(links: SpanLinkRef[]): { traceId: string; spanId: string }[] {
  return links.map((l) => ({ traceId: l.traceId, spanId: l.spanId }));
}

function latestEnd(events: ExecutionEvent[]): Date | undefined {
  let max: Date | undefined;
  for (const e of events) {
    const t = e.endTime ?? e.startTime;
    if (!max || t > max) max = t;
  }
  return max;
}

/** Duration in seconds used for the execution-duration metric. */
export function durationSeconds(rec: ExecutionRecord): number {
  const end = rec.endTime ?? latestEnd(rec.events) ?? rec.startTime;
  return Math.max(0, (end.getTime() - rec.startTime.getTime()) / 1000);
}

export { replayCount };
