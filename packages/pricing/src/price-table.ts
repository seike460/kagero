/**
 * Versioned unit-price table (ADR-009). One JSON file, keyed by
 * (service, region, arch, effectiveFrom). AWS Price List API sync is a
 * roadmap item — entries are hand-curated and updated by PR. Prices are
 * NEVER embedded in the in-MicroVM agent; this package is query-side.
 */
import table from "./price-table.json" with { type: "json" };

export type Service = "microvm" | "lambda" | "managed-instances" | "durable";

export interface PriceEntry {
  service: Service;
  /** AWS region, or "*" for "all regions we didn't list explicitly". */
  region: string;
  /** CPU arch ("x86_64" | "arm64") or "*" when the price is arch-agnostic. */
  arch: string;
  /** ISO date the price applies from — pick the newest entry <= asOf. */
  effectiveFrom: string;
  /** false = the figure is a placeholder awaiting PoC confirmation. */
  verified: boolean;
  source: string;
  prices: Record<string, number>;
}

export interface PriceTable {
  version: number;
  currency: string;
  entries: PriceEntry[];
}

const SERVICES: Service[] = ["microvm", "lambda", "managed-instances", "durable"];

/**
 * Structural validation for the hand-curated JSON — `PRICE_TABLE` takes
 * its type from this assertion alone, so check the parts every estimate
 * relies on: shape, service names, parseable dates, finite numeric
 * prices, and no duplicate (service, region, arch, effectiveFrom) keys.
 * Throws on the first defect — a bad table must fail LOUD at import,
 * not quietly misprice.
 */
export function validatePriceTable(t: unknown): asserts t is PriceTable {
  const tbl = t as PriceTable;
  if (typeof tbl?.version !== "number" || tbl.version < 1) {
    throw new Error("price table: missing/invalid version");
  }
  if (typeof tbl.currency !== "string" || tbl.currency.length !== 3) {
    throw new Error("price table: missing/invalid currency");
  }
  if (!Array.isArray(tbl.entries)) {
    throw new Error("price table: entries must be an array");
  }
  const seen = new Set<string>();
  for (const [i, e] of tbl.entries.entries()) {
    const where = `price table entry[${i}] (${e?.service}/${e?.region}/${e?.arch})`;
    if (!SERVICES.includes(e?.service)) throw new Error(`${where}: unknown service`);
    if (typeof e.region !== "string" || !e.region) throw new Error(`${where}: bad region`);
    if (typeof e.arch !== "string" || !e.arch) throw new Error(`${where}: bad arch`);
    if (
      typeof e.effectiveFrom !== "string" ||
      Number.isNaN(Date.parse(`${e.effectiveFrom}T00:00:00Z`))
    ) {
      throw new Error(`${where}: unparseable effectiveFrom "${e.effectiveFrom}"`);
    }
    if (typeof e.verified !== "boolean") throw new Error(`${where}: verified must be boolean`);
    if (typeof e.source !== "string" || !e.source) throw new Error(`${where}: source required`);
    if (typeof e.prices !== "object" || e.prices === null) {
      throw new Error(`${where}: prices must be an object`);
    }
    for (const [k, v] of Object.entries(e.prices)) {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        throw new Error(`${where}: price "${k}" is not a non-negative finite number`);
      }
    }
    const key = `${e.service}\0${e.region}\0${e.arch}\0${e.effectiveFrom}`;
    if (seen.has(key)) throw new Error(`${where}: duplicate effectiveFrom for this key`);
    seen.add(key);
  }
}

export const PRICE_TABLE: PriceTable = (() => {
  validatePriceTable(table);
  return table;
})();
export const PRICE_TABLE_VERSION = PRICE_TABLE.version;

/**
 * Find the price entry for (service, region, arch) in force at `asOf`
 * (default: now). Exact (region, arch) wins over a "*" wildcard entry in
 * either position; the newest effectiveFrom <= asOf wins within a tier.
 * Returns null when nothing matches — callers decide how to surface it.
 */
export function findPrice(
  service: Service,
  region: string,
  arch = "*",
  asOf: Date = new Date(),
  t: PriceTable = PRICE_TABLE,
): PriceEntry | null {
  const asOfMs = asOf.getTime();
  const candidates = t.entries
    .filter(
      (e) =>
        e.service === service &&
        (e.region === region || e.region === "*") &&
        (e.arch === arch || e.arch === "*") &&
        Date.parse(`${e.effectiveFrom}T00:00:00Z`) <= asOfMs,
    )
    .sort((a, b) => {
      // exactness first, then newest effectiveFrom
      const exactness = (e: PriceEntry) =>
        (e.region === region ? 1 : 0) + (e.arch === arch ? 1 : 0);
      const d = exactness(b) - exactness(a);
      if (d !== 0) return d;
      return (
        Date.parse(`${b.effectiveFrom}T00:00:00Z`) - Date.parse(`${a.effectiveFrom}T00:00:00Z`)
      );
    });
  return candidates.at(0) ?? null;
}

/** All services with at least one price entry. */
export function listServices(t: PriceTable = PRICE_TABLE): Service[] {
  return [...new Set(t.entries.map((e) => e.service))];
}
