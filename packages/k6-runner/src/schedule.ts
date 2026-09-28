/**
 * Start-time synchronisation (§3-2 開始のそろえ方). Every shard receives
 * the same startAtMs and waits for it; the measured skew is reported.
 * The MVP target is a start skew within 2 s across shards.
 */

export interface ClockDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const systemClock: ClockDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export interface StartResult {
  /** Milliseconds actually waited (0 when already past the start). */
  waitedMs: number;
  /**
   * Actual start minus scheduled start, in ms. Positive means the shard
   * started late (it is the skew to report).
   */
  skewMs: number;
}

/**
 * Wait until `startAtMs`, then return how far off the mark we were.
 * `maxWaitMs` bounds how far ahead a schedule may be — a startAtMs far
 * in the future is almost always a misconfiguration. The wait and the
 * k6 run share one invocation, so the 10-minute default leaves a
 * 15-minute Lambda shard at least 5 minutes to run.
 */
export async function waitForStart(
  startAtMs: number,
  deps: ClockDeps = systemClock,
  maxWaitMs = 10 * 60 * 1000,
): Promise<StartResult> {
  // A missing or non-numeric startAtMs would compare false both ways
  // and start at once, with a NaN skew.
  if (!Number.isFinite(startAtMs)) {
    const got = typeof startAtMs === "string" ? JSON.stringify(startAtMs) : String(startAtMs);
    throw new Error(`startAtMs must be a finite epoch-ms number, got ${got}`);
  }
  const before = deps.now();
  const wait = startAtMs - before;
  if (wait > maxWaitMs) {
    throw new Error(
      `startAtMs is ${wait}ms ahead, beyond the ${maxWaitMs}ms limit — check the schedule`,
    );
  }
  if (wait > 0) await deps.sleep(wait);
  const actual = deps.now();
  return { waitedMs: Math.max(0, wait), skewMs: Math.max(0, actual - startAtMs) };
}
