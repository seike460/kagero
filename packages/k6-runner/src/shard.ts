/**
 * Distributed execution sharding (functions-durable-k6.md §3-2).
 *
 * k6 splits a test across instances with --execution-segment and
 * --execution-segment-sequence (verified in the k6 docs):
 *
 *   k6 run --execution-segment "0:1/3" \
 *          --execution-segment-sequence "0,1/3,2/3,1" script.js
 *
 * The sequence lists the boundary values of every shard; shard i of n
 * runs segment "i/n:(i+1)/n".
 */

export interface ShardSpec {
  /** 0-based shard index. */
  index: number;
  /** Total shard count. */
  count: number;
  /** --execution-segment value for this shard. */
  segment: string;
  /** --execution-segment-sequence shared by every shard in the run. */
  sequence: string;
}

function checkCount(count: number): void {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`shard count must be a positive integer, got ${count}`);
  }
}

/** Segment pair for shard `index` of `count` shards. */
export function shardSpec(index: number, count: number): ShardSpec {
  checkCount(count);
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(`shard index must be in [0, ${count}), got ${index}`);
  }
  // Boundary values: literal 0 and 1 at the ends, i/n inside — verified
  // in the k6 docs ("0:1/3", "1/3:2/3", "2/3:1" for a 3-way split).
  const points: string[] = ["0"];
  for (let i = 1; i < count; i++) points.push(`${i}/${count}`);
  points.push("1");
  return {
    index,
    count,
    segment: `${points[index]}:${points[index + 1]}`,
    sequence: points.join(","),
  };
}

/** Shard specs for a Distributed Map / MicroVM fan-out of `count` items. */
export function planShards(count: number): ShardSpec[] {
  checkCount(count);
  return Array.from({ length: count }, (_, i) => shardSpec(i, count));
}
