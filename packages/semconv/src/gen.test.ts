import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  ATTR_KAGERO_MICROVM_IMAGE_NAME,
  ATTR_SERVICE_INSTANCE_ID,
  LIFECYCLE_EVENT_VALUES,
  METRIC_KAGERO_MICROVM_RUNNING_SECONDS,
  METRIC_LABEL_ALLOWED,
  METRIC_LABEL_FORBIDDEN,
} from "./gen.js";

const srcDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const registryPath = join(srcDir, "../../../semconv/registry/kagero.yaml");

describe("generated semconv constants", () => {
  it("exposes attribute names", () => {
    expect(ATTR_KAGERO_MICROVM_IMAGE_NAME).toBe("kagero.microvm.image.name");
    expect(ATTR_SERVICE_INSTANCE_ID).toBe("service.instance.id");
  });

  it("exposes metric names", () => {
    expect(METRIC_KAGERO_MICROVM_RUNNING_SECONDS).toBe("kagero.microvm.running_seconds");
  });

  it("lists lifecycle event values", () => {
    expect(LIFECYCLE_EVENT_VALUES).toContain("suspend");
    expect(LIFECYCLE_EVENT_VALUES).toContain("degraded");
  });

  it("keeps per-instance IDs off metric labels (ADR-008)", () => {
    expect(METRIC_LABEL_FORBIDDEN).toContain("service.instance.id");
    expect(METRIC_LABEL_FORBIDDEN).toContain("kagero.tenant.id");
    expect(METRIC_LABEL_FORBIDDEN).toContain("kagero.session.id");
    expect(METRIC_LABEL_ALLOWED).toContain("kagero.microvm.image.name");
    expect(METRIC_LABEL_ALLOWED).not.toContain("kagero.tenant.id");
  });

  it("covers every attribute and metric in the registry", async () => {
    const registry = parse(readFileSync(registryPath, "utf8")) as {
      groups: {
        type: string;
        attributes?: { id: string }[];
        metric_name?: string;
      }[];
    };
    const genSrc = readFileSync(join(srcDir, "gen.ts"), "utf8");
    for (const g of registry.groups) {
      for (const a of g.attributes ?? []) {
        expect(genSrc).toContain(JSON.stringify(a.id));
      }
      if (g.type === "metric") {
        expect(genSrc).toContain(JSON.stringify(g.metric_name));
      }
    }
  });
});
