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
 * in the future is almost always a misconfiguration.
 */
export async function waitForStart(
  startAtMs: number,
  deps: ClockDeps = systemClock,
  maxWaitMs = 15 * 60 * 1000,
): Promise<StartResult> {
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
