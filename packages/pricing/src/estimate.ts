/**
 * Cost formulas (architecture.md §8, ADR-009). The agent emits usage
 * FACTS only; this package multiplies them by the versioned price table.
 * Every result is an ESTIMATE — free tier and volume discounts excluded.
 *
 * Unit convention: the agent measures GiB (1024³ bytes). AWS prices are
 * labelled "GB" — for Lambda the billed GB is effectively GiB; for
 * MicroVMs the exact unit is unverified (PoC-09). Inputs are named *Gib*
 * to keep the mapping honest; if AWS means 10⁹ bytes, memory terms
 * overcount ~7.4%.
 */
import { findPrice, PRICE_TABLE, type PriceEntry, type PriceTable } from "./price-table.js";

export interface CostComponent {
  /** What was priced, e.g. "running baseline", "snapshot writes". */
  name: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
}

export interface Estimate {
  /** Always true — every figure here is an estimate, never a bill. */
  estimate: true;
  currency: string;
  /** Sum of components; null when no price entry exists to price with. */
  total: number | null;
  components: CostComponent[];
  /** Caveats the caller SHOULD surface next to the numbers. */
  warnings: string[];
  priceTableVersion: number;
}

/** AWS bills partial months continuously; 30 days is the convention. */
export const SECONDS_PER_MONTH = 30 * 24 * 60 * 60;

const BASE_WARNINGS = [
  "estimate only — excludes free tier and volume discounts",
  "reconcile against CUR (Cost and Usage Report) before relying on the figure",
];

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Read a unit price; a missing/malformed key in the hand-curated table
 * must NOT silently become $0 — the consumer gets a warning instead of a
 * confident understated total.
 */
function price(e: PriceEntry, key: string, warnings: string[]): number {
  const v = e.prices[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    warnings.push(
      `price table ${e.service}/${e.region}/${e.arch} lacks key "${key}" — priced as $0`,
    );
    return 0;
  }
  return v;
}

function component(name: string, quantity: number, unit: string, unitPrice: number): CostComponent {
  return { name, quantity, unit, unitPrice, amount: round6(quantity * unitPrice) };
}

function assemble(components: CostComponent[], warnings: string[], table: PriceTable): Estimate {
  return {
    estimate: true,
    currency: table.currency,
    total: round6(components.reduce((a, c) => a + c.amount, 0)),
    components,
    warnings,
    priceTableVersion: table.version,
  };
}

function unpriced(service: string, region: string, table: PriceTable): Estimate {
  return {
    estimate: true,
    currency: table.currency,
    total: null,
    components: [],
    warnings: [
      `no ${service} price entry for region ${region} — cannot estimate`,
      ...BASE_WARNINGS,
    ],
    priceTableVersion: table.version,
  };
}

function entryWarnings(e: PriceEntry, extra: string[] = []): string[] {
  return [
    ...(e.verified ? [] : [`price entry for ${e.service}/${e.region} is UNVERIFIED (${e.source})`]),
    ...extra,
    ...BASE_WARNINGS,
  ];
}

// ---------- Lambda function (on-demand) ----------

export interface LambdaUsage {
  /** Invocation count. */
  requests: number;
  /** Σ billed duration (incl. INIT/cold start) × memory GiB, in GiB-seconds. */
  gibSeconds: number;
  /** Σ ephemeral-storage beyond the 512MiB free allowance, GiB-seconds. */
  ephemeralStorageGibSeconds?: number;
}

export function estimateLambda(
  usage: LambdaUsage,
  opts: { region: string; arch?: "x86_64" | "arm64"; asOf?: Date },
  table: PriceTable = PRICE_TABLE,
): Estimate {
  const e = findPrice("lambda", opts.region, opts.arch ?? "x86_64", opts.asOf, table);
  if (!e) return unpriced("lambda", opts.region, table);
  const warnings: string[] = [];
  const components = [
    component("requests", usage.requests, "requests", price(e, "request", warnings)),
    component("duration", usage.gibSeconds, "GB-s", price(e, "gbSecond", warnings)),
  ];
  if (usage.ephemeralStorageGibSeconds) {
    components.push(
      component(
        "ephemeral storage",
        usage.ephemeralStorageGibSeconds,
        "GB-s",
        price(e, "ephemeralStorageGbSecond", warnings),
      ),
    );
  }
  return assemble(components, entryWarnings(e, warnings), table);
}

// ---------- Lambda Managed Instances ----------

export interface ManagedInstancesUsage {
  /** Invocation count (per-request fee still applies). */
  requests: number;
  /** EC2 instance spend for the capacity provider, from CUR — REQUIRED. */
  ec2CostUsd: number;
}

export function estimateManagedInstances(
  usage: ManagedInstancesUsage,
  opts: { region: string; asOf?: Date },
  table: PriceTable = PRICE_TABLE,
): Estimate {
  const e = findPrice("managed-instances", opts.region, "*", opts.asOf, table);
  if (!e) return unpriced("managed-instances", opts.region, table);
  const warnings: string[] = [];
  const feeRate = price(e, "ec2ManagementFeeRate", warnings);
  const components = [
    component("requests", usage.requests, "requests", price(e, "request", warnings)),
    component("EC2 instances", usage.ec2CostUsd, "USD", 1),
    component("EC2 management fee", usage.ec2CostUsd, "USD", feeRate),
  ];
  return assemble(
    components,
    entryWarnings(e, [
      "ec2CostUsd must come from CUR — this package does not price EC2 itself",
      ...warnings,
    ]),
    table,
  );
}

// ---------- Lambda Durable Functions ----------

export interface DurableUsage {
  /** Checkpoint/replay operation count (DurableExecution* metrics). */
  operations: number;
  /** The underlying Lambda function cost (compute it via estimateLambda). */
  functionCostUsd?: number;
}

export function estimateDurable(
  usage: DurableUsage,
  opts: { region: string; asOf?: Date },
  table: PriceTable = PRICE_TABLE,
): Estimate {
  const e = findPrice("durable", opts.region, "*", opts.asOf, table);
  if (!e) return unpriced("durable", opts.region, table);
  const warnings: string[] = [];
  const components = [
    component("operations", usage.operations, "operations", price(e, "operation", warnings)),
  ];
  if (usage.functionCostUsd !== undefined) {
    components.push(component("function duration+requests", usage.functionCostUsd, "USD", 1));
  }
  return assemble(
    components,
    entryWarnings(e, [
      ...(usage.functionCostUsd === undefined
        ? ["function-side Lambda cost not included — pass functionCostUsd from estimateLambda"]
        : []),
      ...warnings,
    ]),
    table,
  );
}

// ---------- Lambda MicroVMs ----------

export interface MicrovmUsage {
  /** Seconds in RUNNING state (kagero.microvm.running_seconds). */
  runningSeconds: number;
  /** Baseline memory allocation, GiB (kagero.microvm.size "2gb" → 2). */
  baselineGib: number;
  /** Baseline vCPU (2 GiB → 1 vCPU). */
  baselineVcpu: number;
  /** Σ above-baseline memory (kagero.microvm.burst_memory_gib_seconds). */
  burstGibSeconds: number;
  /** Σ above-baseline vCPU (kagero.microvm.burst_vcpu_seconds). */
  burstVcpuSeconds: number;
  /** Snapshot/image size, GiB — multiplies the load/write/storage prices. */
  snapshotGib: number;
  /** Cold starts (snapshot loads at boot). */
  coldStarts: number;
  /** Resumes from suspend — billed as loads per the pricing page; the
   * actual billing behavior is still PoC-09 unverified → warning. */
  resumes: number;
  /** Suspend events (snapshot writes). */
  suspends: number;
  /** Seconds spent suspended (usage.suspend_seconds) — converted to
   * snapshot GiB-months internally via SECONDS_PER_MONTH. */
  suspendSeconds: number;
}

/** kagero.microvm.size ("0.5gb"…"8gb") → baseline GiB and vCPU (2 GiB = 1 vCPU). */
export function parseMicrovmSize(
  size: string,
): { baselineGib: number; baselineVcpu: number } | null {
  const m = /^(\d+(?:\.\d+)?)gb$/i.exec(size.trim());
  if (!m) return null;
  const gib = Number(m[1]);
  if (!Number.isFinite(gib) || gib <= 0) return null;
  return { baselineGib: gib, baselineVcpu: gib / 2 };
}

export function estimateMicrovm(
  usage: MicrovmUsage,
  opts: { region: string; arch?: "arm64" | "x86_64"; asOf?: Date },
  table: PriceTable = PRICE_TABLE,
): Estimate {
  const e = findPrice("microvm", opts.region, opts.arch ?? "arm64", opts.asOf, table);
  if (!e) return unpriced("microvm", opts.region, table);
  const warnings: string[] = [];
  const memPrice = price(e, "memoryGbSecond", warnings);
  const vcpuPrice = price(e, "vcpuSecond", warnings);
  const loads = usage.coldStarts + usage.resumes;
  const suspendedGibMonths = (usage.suspendSeconds / SECONDS_PER_MONTH) * usage.snapshotGib;
  if (usage.snapshotGib === 0 && (loads > 0 || usage.suspends > 0 || usage.suspendSeconds > 0)) {
    warnings.push(
      "snapshotGib is 0 but load/write/storage events occurred — snapshot size is unverified (PoC-09); those components are $0",
    );
  }
  const components = [
    component("baseline memory", usage.runningSeconds * usage.baselineGib, "GB-s", memPrice),
    component("baseline vCPU", usage.runningSeconds * usage.baselineVcpu, "vCPU-s", vcpuPrice),
    component("burst memory", usage.burstGibSeconds, "GB-s", memPrice),
    component("burst vCPU", usage.burstVcpuSeconds, "vCPU-s", vcpuPrice),
    component(
      "snapshot loads",
      loads * usage.snapshotGib,
      "GB",
      price(e, "snapshotLoadGb", warnings),
    ),
    component(
      "snapshot writes",
      usage.suspends * usage.snapshotGib,
      "GB",
      price(e, "snapshotWriteGb", warnings),
    ),
    component(
      "suspended storage",
      suspendedGibMonths,
      "GB-month",
      price(e, "storageGbMonth", warnings),
    ),
  ];
  return assemble(
    components,
    entryWarnings(e, [
      "burst allocation vs observed usage is unverified (PoC-09)",
      ...(usage.resumes > 0
        ? ["snapshot-load charge on RESUME is unverified (PoC-09) — may overcount"]
        : []),
      "data transfer and image storage are not priced (scope gap vs the billing page)",
      ...warnings,
    ]),
    table,
  );
}
