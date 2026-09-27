/**
 * Emit committed v1 JSON under generated/ (architecture.md §7):
 *   generated/dashboards/{lgtm,cloudwatch}/microvm-overview.json
 *   generated/alerts/{lgtm,cloudwatch}/microvm-alerts.json
 * CI regenerates and diffs — hand edits to generated/ always show up.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adapterFor, type Backend } from "./adapters.js";
import { buildAlertOutput } from "./alerts.js";
import { dashboardJson } from "./build.js";
import { microvmOverview } from "./spec.js";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repo = resolve(here, "../../..");

export function outputs(): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  for (const backend of ["lgtm", "cloudwatch"] as Backend[]) {
    const adapter = adapterFor(backend);
    out.push({
      path: join(repo, "generated", "dashboards", backend, "microvm-overview.json"),
      content: dashboardJson(microvmOverview, adapter),
    });
    out.push({
      path: join(repo, "generated", "alerts", backend, "microvm-alerts.json"),
      content: `${JSON.stringify(buildAlertOutput(adapter), null, 2)}\n`,
    });
  }
  return out;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  for (const { path, content } of outputs()) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    console.log(`wrote ${path}`);
  }
}
