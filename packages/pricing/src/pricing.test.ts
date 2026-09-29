import { describe, expect, it } from "vitest";
import {
  estimateDurable,
  estimateLambda,
  estimateManagedInstances,
  estimateMicrovm,
  findPrice,
  listServices,
  PRICE_TABLE,
  PRICE_TABLE_VERSION,
  parseMicrovmSize,
  SECONDS_PER_MONTH,
  validatePriceTable,
} from "./index.js";

describe("findPrice", () => {
  it("finds the microvm us-east-1 entry", () => {
    const e = findPrice("microvm", "us-east-1", "arm64");
    expect(e?.prices.memoryGbSecond).toBe(0.0000036667);
    expect(e?.verified).toBe(true);
  });

  it("pins every published microvm price to a literal", () => {
    const p = findPrice("microvm", "us-east-1", "arm64")?.prices;
    expect(p?.memoryGbSecond).toBe(0.0000036667);
    expect(p?.vcpuSecond).toBe(0.0000276944);
    expect(p?.snapshotLoadGb).toBe(0.00155);
    expect(p?.snapshotWriteGb).toBe(0.0038);
    expect(p?.storageGbMonth).toBe(0.08);
  });

  it("falls back to wildcard region for lambda", () => {
    const e = findPrice("lambda", "eu-west-1", "x86_64");
    expect(e?.region).toBe("*");
    expect(e?.prices.gbSecond).toBe(0.0000166667);
  });

  it("returns null for an unpriced service/region combo", () => {
    expect(findPrice("microvm", "eu-central-1", "arm64")).toBeNull();
  });

  it("respects effectiveFrom — a future entry does not apply", () => {
    const t = {
      version: 99,
      currency: "USD",
      entries: [
        {
          service: "durable" as const,
          region: "*",
          arch: "*",
          effectiveFrom: "2099-01-01",
          verified: true,
          source: "future",
          prices: { operation: 1 },
        },
      ],
    };
    expect(findPrice("durable", "us-east-1", "*", new Date("2026-01-01"), t)).toBeNull();
  });

  it("a newer same-key entry replaces the older one (versioning)", () => {
    const t = {
      version: 99,
      currency: "USD",
      entries: [
        {
          service: "durable" as const,
          region: "*",
          arch: "*",
          effectiveFrom: "2025-12-02",
          verified: true,
          source: "old",
          prices: { operation: 8e-6 },
        },
        {
          service: "durable" as const,
          region: "*",
          arch: "*",
          effectiveFrom: "2026-07-01",
          verified: true,
          source: "new",
          prices: { operation: 7e-6 },
        },
      ],
    };
    const before = findPrice("durable", "us-east-1", "*", new Date("2026-06-01"), t);
    const after = findPrice("durable", "us-east-1", "*", new Date("2026-07-01"), t);
    expect(before?.prices.operation).toBe(8e-6);
    expect(after?.prices.operation).toBe(7e-6);
    expect(after?.source).toBe("new");
  });

  it("effectiveFrom boundary is inclusive", () => {
    const e = findPrice("microvm", "us-east-1", "arm64", new Date("2026-06-22"));
    expect(e?.prices.memoryGbSecond).toBe(0.0000036667);
  });

  it("prices no microvm before the 2026-06-22 launch", () => {
    for (const region of ["us-east-1", "ap-northeast-1"]) {
      expect(findPrice("microvm", region, "arm64", new Date("2026-06-21T23:59:59Z"))).toBeNull();
    }
  });

  it("exact region beats wildcard", () => {
    const e = findPrice("microvm", "ap-northeast-1", "arm64");
    expect(e?.region).toBe("ap-northeast-1");
    expect(e?.verified).toBe(false);
  });
});

describe("validatePriceTable", () => {
  it("accepts the shipped table", () => {
    expect(() => validatePriceTable(PRICE_TABLE)).not.toThrow();
  });
  it("rejects a non-numeric price", () => {
    expect(() =>
      validatePriceTable({
        version: 1,
        currency: "USD",
        entries: [
          {
            service: "durable",
            region: "*",
            arch: "*",
            effectiveFrom: "2025-12-02",
            verified: true,
            source: "x",
            prices: { operation: "8e-6" },
          },
        ],
      }),
    ).toThrow(/finite number/);
  });
  it("rejects an unparseable effectiveFrom", () => {
    expect(() =>
      validatePriceTable({
        version: 1,
        currency: "USD",
        entries: [
          {
            service: "durable",
            region: "*",
            arch: "*",
            effectiveFrom: "soon",
            verified: true,
            source: "x",
            prices: { operation: 1 },
          },
        ],
      }),
    ).toThrow(/effectiveFrom/);
  });
  it("rejects duplicate keys", () => {
    const entry = {
      service: "durable",
      region: "*",
      arch: "*",
      effectiveFrom: "2025-12-02",
      verified: true,
      source: "x",
      prices: { operation: 1 },
    };
    expect(() =>
      validatePriceTable({ version: 1, currency: "USD", entries: [entry, entry] }),
    ).toThrow(/duplicate/);
  });
});

describe("estimateLambda", () => {
  it("prices requests + GiB-seconds (x86)", () => {
    const est = estimateLambda(
      { requests: 1_000_000, gibSeconds: 100_000 },
      { region: "us-east-1", arch: "x86_64" },
    );
    // 1M * 0.20e-6 = 0.20 + 100_000 * 0.0000166667 = 1.66667
    expect(est.total).toBeCloseTo(1.86667, 4);
    expect(est.estimate).toBe(true);
    expect(est.components.map((c) => c.name)).toEqual(["requests", "duration"]);
  });

  it("arm64 uses the cheaper GiB-second price", () => {
    const est = estimateLambda(
      { requests: 1_000_000, gibSeconds: 100_000 },
      { region: "us-east-1", arch: "arm64" },
    );
    expect(est.total).toBeCloseTo(0.2 + 100_000 * 0.0000133334, 4);
  });

  it("includes ephemeral storage when provided", () => {
    const est = estimateLambda(
      { requests: 0, gibSeconds: 0, ephemeralStorageGibSeconds: 1_000_000 },
      { region: "us-east-1" },
    );
    expect(est.total).toBeCloseTo(1_000_000 * 0.0000000309, 6);
  });
});

describe("estimateManagedInstances", () => {
  it("requests fee + EC2 × 1.15", () => {
    const est = estimateManagedInstances(
      { requests: 5_000_000, ec2CostUsd: 100 },
      { region: "us-east-1" },
    );
    // 5M * 0.20e-6 = 1.00 + 100 + 15 = 116.00
    expect(est.total).toBeCloseTo(116.0, 4);
    expect(est.warnings.join(" ")).toMatch(/CUR/);
  });
});

describe("estimateDurable", () => {
  it("operations + optional function cost", () => {
    const est = estimateDurable(
      { operations: 1_000_000, functionCostUsd: 2.5 },
      { region: "us-east-1" },
    );
    expect(est.total).toBeCloseTo(10.5, 4);
  });

  it("warns when function cost omitted", () => {
    const est = estimateDurable({ operations: 1 }, { region: "us-east-1" });
    expect(est.warnings.join(" ")).toMatch(/function-side Lambda cost/);
  });
});

describe("estimateMicrovm", () => {
  const usage = {
    runningSeconds: 3600,
    baselineGib: 2,
    baselineVcpu: 1,
    burstGibSeconds: 100,
    burstVcpuSeconds: 50,
    snapshotGib: 1.5,
    coldStarts: 10,
    resumes: 4,
    suspends: 4,
    suspendSeconds: SECONDS_PER_MONTH / 2, // ≈0.75 GiB-months at 1.5GiB
  };

  it("prices all components with literal expectations", () => {
    const est = estimateMicrovm(usage, { region: "us-east-1" });
    const expected =
      3600 * 2 * 0.0000036667 + // baseline memory
      3600 * 1 * 0.0000276944 + // baseline vCPU
      100 * 0.0000036667 + // burst memory
      50 * 0.0000276944 + // burst vCPU
      (10 + 4) * 1.5 * 0.00155 + // snapshot loads (starts+resumes)
      4 * 1.5 * 0.0038 + // snapshot writes
      (SECONDS_PER_MONTH / 2 / SECONDS_PER_MONTH) * 1.5 * 0.08; // storage
    expect(est.total).toBeCloseTo(expected, 4);
    expect(est.components).toHaveLength(7);
  });

  it("warns that resume-load billing is unverified", () => {
    const est = estimateMicrovm(usage, { region: "us-east-1" });
    expect(est.warnings.join(" ")).toMatch(/RESUME is unverified/);
    expect(est.warnings.join(" ")).toMatch(/estimate only/);
  });

  it("warns when snapshotGib=0 but snapshot events occurred", () => {
    const est = estimateMicrovm({ ...usage, snapshotGib: 0 }, { region: "us-east-1" });
    expect(est.warnings.join(" ")).toMatch(/snapshotGib is 0/);
  });

  it("marks the unverified Tokyo entry", () => {
    const est = estimateMicrovm(usage, { region: "ap-northeast-1" });
    expect(est.warnings.join(" ")).toMatch(/UNVERIFIED/);
  });

  it("returns total null for an unpriced region", () => {
    const est = estimateMicrovm(usage, { region: "eu-central-1" });
    expect(est.total).toBeNull();
    expect(est.components).toHaveLength(0);
  });
});

describe("parseMicrovmSize", () => {
  it("maps kagero.microvm.size to baseline Gib/vCPU", () => {
    expect(parseMicrovmSize("2gb")).toEqual({ baselineGib: 2, baselineVcpu: 1 });
    expect(parseMicrovmSize("0.5gb")).toEqual({ baselineGib: 0.5, baselineVcpu: 0.25 });
    expect(parseMicrovmSize("8GB")).toEqual({ baselineGib: 8, baselineVcpu: 4 });
  });
  it("rejects malformed sizes", () => {
    expect(parseMicrovmSize("2")).toBeNull();
    expect(parseMicrovmSize("large")).toBeNull();
    expect(parseMicrovmSize("0gb")).toBeNull();
  });
});

describe("table", () => {
  it("is versioned and covers all four services", () => {
    expect(PRICE_TABLE_VERSION).toBeGreaterThanOrEqual(1);
    expect(listServices().sort()).toEqual(["durable", "lambda", "managed-instances", "microvm"]);
  });

  it("declares USD", () => {
    expect(PRICE_TABLE.currency).toBe("USD");
  });
});
