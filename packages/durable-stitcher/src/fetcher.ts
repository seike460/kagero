/**
 * History fetching (functions-durable-k6.md §2-2: ST → GetDurableExecutionHistory).
 * The canonical input is ExecutionRecord; the AWS-SDK path lazily
 * imports the client so unit tests need no AWS dependency.
 *
 * Wire shape verified against the API reference (2025-12-01):
 * GET /durable-executions/{arn}/history → { Events[], NextMarker? }.
 * Execution-level facts live inside Events: ExecutionStarted/
 * ExecutionSucceeded|Failed|TimedOut|Stopped carry no Id; entity
 * events (Step*, Wait*, Callback*, ChainedInvoke*, Context*) share
 * an Id across their Started→terminal pair; ParentId links steps.
 */
import {
  type ExecutionRecord,
  type HistoryApiResponse,
  normalizeTransitions,
  statusOf,
  toDate,
} from "./model.js";

export interface HistoryFetcher {
  getHistory(executionArn: string): Promise<ExecutionRecord>;
}

/** Fixed-record fetcher for tests and offline replay. */
export function fixtureFetcher(rec: ExecutionRecord): HistoryFetcher {
  return {
    async getHistory(arn: string) {
      if (arn !== rec.executionArn) throw new Error(`fixture: unknown arn ${arn}`);
      return rec;
    },
  };
}

/** "/durable-execution/<name>/<id>" → name, if the arn carries one. */
export function executionNameFromArn(arn: string): string | undefined {
  const m = /\/durable-execution\/([a-zA-Z0-9_-]+)\/[a-zA-Z0-9_-]+$/.exec(arn);
  return m?.[1];
}

/**
 * Map a GetDurableExecutionHistory response (already concatenated
 * across pages) to the canonical record.
 */
export function normalizeApiResponse(
  executionArn: string,
  res: HistoryApiResponse,
): ExecutionRecord {
  const events = res.Events ?? [];
  const started = events.find((e) => e.EventType === "ExecutionStarted");
  // Last terminal wins: a replay after ExecutionFailed legitimately
  // places a terminal event mid-history (a new ExecutionStarted follows
  // it), so only the final terminal reflects the execution's outcome.
  const terminal = [...events]
    .reverse()
    .find((e) =>
      /^(ExecutionSucceeded|ExecutionFailed|ExecutionTimedOut|ExecutionStopped)$/i.test(
        e.EventType,
      ),
    );
  // Replays ≈ completed invocations beyond the first (each wait/callback
  // re-invokes the function). Step retries add on top via evidence.
  const invocations = events.filter((e) => e.EventType === "InvocationCompleted").length;
  const replayCount = Math.max(0, invocations - 1);

  const children = normalizeTransitions(events);
  const starts = children.map((e) => e.startTime.getTime());
  const ends = children.map((e) => (e.endTime ?? e.startTime).getTime());

  const rec: ExecutionRecord = {
    executionArn,
    status: terminal ? statusOf(terminal.EventType) : "running",
    startTime:
      toDate(started?.EventTimestamp) ?? new Date(starts.length ? Math.min(...starts) : Date.now()),
    replayCount,
    events: children,
  };
  const name = executionNameFromArn(executionArn);
  if (name) rec.name = name;
  const end = terminal
    ? toDate(terminal.EventTimestamp)
    : ends.length
      ? new Date(Math.max(...ends))
      : undefined;
  if (end) rec.endTime = end;
  return rec;
}

/**
 * Lambda control-plane fetcher. Pages through NextMarker until the
 * full history is collected (MaxItems default 100, max 1000).
 */
export function lambdaApiFetcher(opts: { region?: string } = {}): HistoryFetcher {
  return {
    async getHistory(executionArn: string): Promise<ExecutionRecord> {
      const mod = await import("@aws-sdk/client-lambda");
      const client = new mod.LambdaClient(opts.region ? { region: opts.region } : {});
      const Cmd = (mod as Record<string, unknown>).GetDurableExecutionHistoryCommand as
        | (new (
            input: Record<string, unknown>,
          ) => unknown)
        | undefined;
      if (!Cmd) {
        throw new Error(
          "@aws-sdk/client-lambda has no GetDurableExecutionHistoryCommand — " +
            "check the SDK version against the 2025-12-01 API",
        );
      }
      const send = client.send as (cmd: unknown) => Promise<HistoryApiResponse>;
      const all: HistoryApiResponse["Events"] = [];
      let marker: string | undefined;
      do {
        const res = await send(
          new Cmd({
            DurableExecutionArn: executionArn,
            IncludeExecutionData: false,
            ...(marker ? { Marker: marker } : {}),
          }),
        );
        all.push(...(res.Events ?? []));
        marker = res.NextMarker;
      } while (marker);
      return normalizeApiResponse(executionArn, { Events: all });
    },
  };
}
