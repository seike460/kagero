/**
 * Canonical execution model the stitcher consumes (functions-durable-k6.md §2).
 * Everything AWS-specific is normalized INTO this shape in fetcher.ts —
 * the assembler and exporter only ever see these types.
 *
 * Wire shape: verified against GetDurableExecutionHistory
 * (docs.aws.amazon.com/lambda/latest/api/API_GetDurableExecutionHistory.html,
 * API version 2025-12-01). Events carry EventType/Id/ParentId/
 * EventTimestamp plus per-type *Details objects; retry attempts appear
 * in StepFailedDetails.RetryDetails.CurrentAttempt.
 */
export type StepKind = "step" | "wait" | "callback" | "retry" | "chained" | "invoke" | "context";

export type DurableStatus = "succeeded" | "failed" | "timed_out" | "stopped" | "running";

export interface SpanLinkRef {
  traceId: string;
  spanId: string;
}

export interface ExecutionEvent {
  /** Stable id inside this execution — drives deterministic span ids. */
  id: string;
  kind: StepKind;
  name?: string;
  status: DurableStatus;
  startTime: Date;
  endTime?: Date;
  /** Parent entity id (the API's ParentId) — resolved to a span when known. */
  parentId?: string;
  /** Retry attempt number (>=2 means this event is a replay attempt). */
  attempt?: number;
  /** Links to per-invocation traces emitted elsewhere (§2-2). Reserved —
   *  normalizeTransitions never populates this; only enrichers/fixtures set it. */
  links?: SpanLinkRef[];
  /** Reserved — populated by enrichers/fixtures, not by normalizeTransitions. */
  attributes?: Record<string, string | number | boolean>;
}

export interface ExecutionRecord {
  executionArn: string;
  name?: string;
  status: DurableStatus;
  startTime: Date;
  endTime?: Date;
  /** Replay count the caller computed; assembleTrace maxes it with evidence. */
  replayCount: number;
  events: ExecutionEvent[];
}

/** History API event — exact field names of the wire response. */
export interface HistoryApiEvent {
  EventId: number;
  EventType: string;
  /** Epoch timestamp (seconds as a float, or ms — toDate handles both). */
  EventTimestamp: number | string | Date;
  /** Entity id correlating Started/Succeeded/Failed on the same step. */
  Id?: string;
  ParentId?: string;
  Name?: string;
  SubType?: string;
  /** Per-type *Details objects (StepFailedDetails, etc.). */
  [details: string]: unknown;
}

export interface HistoryApiResponse {
  Events: HistoryApiEvent[];
  NextMarker?: string;
}

/** Epoch seconds (<1e12), epoch ms (>=1e12), ISO strings, Date → Date. */
export function toDate(ts: number | string | Date | undefined): Date | undefined {
  if (ts === undefined) return undefined;
  if (ts instanceof Date) return ts;
  if (typeof ts === "string") {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return new Date(ts >= 1e12 ? ts : ts * 1000);
}

const KIND_BY_HEAD: Record<string, StepKind> = {
  step: "step",
  wait: "wait",
  callback: "callback",
  chainedinvoke: "chained",
  invoke: "invoke",
  context: "context",
};

const TERMINAL = /(Succeeded|Failed|TimedOut|Cancelled|Stopped|Completed)$/i;
const STARTED = /Started$/i;

function headOf(eventType: string): string {
  return eventType
    .replace(/(Started|Succeeded|Failed|TimedOut|Cancelled|Stopped|Completed)$/i, "")
    .toLowerCase();
}

function kindOf(eventType: string): StepKind {
  return KIND_BY_HEAD[headOf(eventType)] ?? "step";
}

/** Terminal suffix → canonical status; anything else means still running. */
export function statusOf(eventType: string): DurableStatus {
  if (/TimedOut$/i.test(eventType)) return "timed_out";
  if (/(Stopped|Cancelled)$/i.test(eventType)) return "stopped";
  if (/Failed$/i.test(eventType)) return "failed";
  if (/(Succeeded|Completed)$/i.test(eventType)) return "succeeded";
  return "running";
}

/** RetryDetails.CurrentAttempt lives inside *Details objects. */
function currentAttempt(e: HistoryApiEvent): number | undefined {
  for (const [k, v] of Object.entries(e)) {
    if (!k.endsWith("Details") || typeof v !== "object" || v === null) continue;
    const retry = (v as Record<string, unknown>).RetryDetails;
    if (typeof retry === "object" && retry !== null) {
      const n = (retry as Record<string, unknown>).CurrentAttempt;
      if (typeof n === "number") return n;
    }
  }
  return undefined;
}

/**
 * Pair sequential Started/terminal transitions sharing one Id into
 * ExecutionEvents. A retry shows as a new Started on the SAME Id after
 * a Failed terminal — each cycle becomes its own event, with attempt
 * taken from RetryDetails.CurrentAttempt (or incremented).
 * Execution-level events (Id absent) are not children — they describe
 * the execution itself and are handled by the caller.
 */
export function normalizeTransitions(events: HistoryApiEvent[]): ExecutionEvent[] {
  const out: ExecutionEvent[] = [];
  const open = new Map<string, HistoryApiEvent>();
  const cycles = new Map<string, number>();

  const keyOf = (e: HistoryApiEvent) => e.Id ?? `event-${e.EventId}`;

  const emit = (
    start: HistoryApiEvent,
    end: HistoryApiEvent | undefined,
    forcedKind?: StepKind,
  ): void => {
    const id = keyOf(start);
    const n = (cycles.get(id) ?? 0) + 1;
    cycles.set(id, n);
    const attempt = (end && currentAttempt(end)) ?? (n > 1 ? n : undefined);
    const ev: ExecutionEvent = {
      // Deterministic id: entity id + cycle count.
      id: n === 1 ? id : `${id}#${n}`,
      kind: forcedKind ?? (n > 1 ? "retry" : kindOf(start.EventType)),
      status: end ? statusOf(end.EventType) : "running",
      startTime: toDate(start.EventTimestamp) ?? new Date(0),
    };
    const name = end?.Name ?? start.Name;
    if (name !== undefined) ev.name = name;
    const parent = start.ParentId ?? end?.ParentId;
    if (parent !== undefined) ev.parentId = parent;
    if (attempt !== undefined) ev.attempt = attempt;
    if (end) {
      const t = toDate(end.EventTimestamp);
      if (t) ev.endTime = t;
    }
    out.push(ev);
  };

  for (const e of events) {
    if (e.Id === undefined) continue; // execution-level events
    if (STARTED.test(e.EventType)) {
      const prev = open.get(keyOf(e));
      if (prev) emit(prev, undefined); // dangling open → still running
      open.set(keyOf(e), e);
      continue;
    }
    if (TERMINAL.test(e.EventType)) {
      const start = open.get(keyOf(e));
      if (start) {
        open.delete(keyOf(e));
        emit(start, e);
      } else {
        // Orphan terminal: instantaneous event.
        const fake: HistoryApiEvent = {
          EventId: e.EventId,
          EventType: e.EventType,
          EventTimestamp: e.EventTimestamp,
          Id: e.Id,
          Name: e.Name,
          ParentId: e.ParentId,
        };
        emit(fake, e);
      }
    }
    // Other transitions (e.g. checkpoint markers) are skipped.
  }
  for (const start of open.values()) emit(start, undefined);
  return out;
}
