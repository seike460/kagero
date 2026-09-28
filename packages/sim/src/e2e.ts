/**
 * Standalone E2E driver — `pnpm sim:e2e`. Spawns the real agent binary,
 * drives the full lifecycle, and verifies the observable contract:
 *   - all hooks answered 2xx, in the real runtime order
 *   - the app received every hook (arrival log persists past its death)
 *   - suspend/terminate reached the app BEFORE the agent's lifecycle
 *     event (app-first ordering per ADR-004)
 *   - the agent emitted usage + lifecycle metrics with NO forbidden
 *     attributes on metric datapoints or resources (ADR-008)
 *   - the app is dead after /terminate and the agent still answers
 */
import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startSim } from "./scenario.js";
import {
  firstBadResult,
  forbiddenMetricKeys,
  isAppHookLog,
  isLifecycle,
  metricNames,
  nonMonotonicSumNames,
  resourceAttrValues,
} from "./verify.js";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repo = resolve(here, "../../..");
/** Resolved agent binary path — shared by the CLI, tests, and importers. */
export const agentBin = process.env.KAGERO_AGENT_BIN ?? join(repo, "target", "debug", "kagero");
/** The test app beside this module: test-app.ts under src/, test-app.js under dist/. */
export const testAppPath = join(here, `test-app${extname(fileURLToPath(import.meta.url))}`);

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export async function runE2E(): Promise<{ checks: Check[]; ok: boolean }> {
  if (!existsSync(agentBin)) {
    throw new Error(
      `agent binary not found at ${agentBin} — run \`cargo build -p kagero-agent\` first`,
    );
  }
  const sim = await startSim({
    agentBin,
    testAppPath,
    suspendCycles: 2,
    suspendPauseMs: 400,
  });
  const checks: Check[] = [];
  try {
    const res = await sim.run();

    const bad = firstBadResult(res.lifecycle.results);
    checks.push({
      name: "all hooks answered 2xx",
      ok: !bad,
      detail: bad ? `${bad.hook} -> ${bad.status}` : undefined,
    });
    checks.push({
      name: "hook order matches the runtime contract",
      ok:
        res.lifecycle.sequence().join(",") ===
        "ready,validate,run,suspend,resume,suspend,resume,terminate",
      detail: res.lifecycle.sequence().join(","),
    });

    const arrivals = res.appArrivals.map((a) => a.hook);
    checks.push({
      name: "app received every hook in order",
      ok: arrivals.join(",") === "ready,validate,run,suspend,resume,suspend,resume,terminate",
      detail: arrivals.join(","),
    });
    const runArrival = res.appArrivals.find((a) => a.hook === "run");
    // Full-fidelity check: the ENTIRE runHookPayload subtree must arrive
    // unchanged — the agent relays it byte-for-byte and must not drop,
    // rename, or mutate fields (the app is untrusted but the relay is not).
    const rp = runArrival?.runHookPayload as
      | { tenant?: { id?: string }; session?: string }
      | undefined;
    checks.push({
      name: "runHookPayload reached the app unchanged (id + nested payload)",
      ok:
        runArrival?.microvmId === "sim-mvm-1" &&
        rp?.tenant?.id === "tenant-a" &&
        rp?.session === "session-1",
      detail: JSON.stringify(runArrival?.runHookPayload),
    });

    const forbidden = forbiddenMetricKeys(res.otlp);
    checks.push({
      name: "no forbidden attrs on metric datapoints/resources (ADR-008)",
      ok: forbidden.length === 0,
      detail: forbidden.join(","),
    });

    // Every `sum` must be monotonic+cumulative — that is the condition
    // under which Prometheus OTLP ingest appends the `_total` suffix
    // the dashboards' selectors rely on.
    const nonMono = nonMonotonicSumNames(res.otlp);
    checks.push({
      name: "all sum metrics are monotonic+cumulative (Prom _total contract)",
      ok: nonMono.length === 0,
      detail: nonMono.join(","),
    });

    const names = metricNames(res.otlp);
    if (sim.realCollector) {
      // The app emitted a metric with forbidden attrs at ALL THREE levels
      // (resource/scope/datapoint — test-app.ts hostileMetric). For it to
      // arrive at the sink at all, the real collector pipeline must have
      // accepted it; the forbidden-keys check above proves the stripping.
      checks.push({
        name: "real collector pipeline delivered the hostile metric, stripped",
        ok: names.includes("sim.app.hostile_gauge"),
        detail: names.join(","),
      });
      // Tenant/session extraction ran end-to-end: KAGERO_*_JSON_POINTER
      // pulls the ids out of the /run body, the rendered collector stamps
      // them on log resources (logs keep full identity — ADR-008
      // restricts metrics only).
      const tenants = resourceAttrValues(res.otlp, "/v1/logs", "kagero.tenant.id");
      const sessions = resourceAttrValues(res.otlp, "/v1/logs", "kagero.session.id");
      checks.push({
        name: "tenant/session extracted from /run body and stamped on logs",
        ok: tenants.includes("tenant-a") && sessions.includes("session-1"),
        detail: `tenant=[${tenants.join(",")}] session=[${sessions.join(",")}]`,
      });
    }
    for (const expected of [
      "kagero.microvm.lifecycle_transitions",
      "kagero.microvm.running_seconds",
    ]) {
      checks.push({
        name: `agent metric emitted: ${expected}`,
        ok: names.includes(expected),
        detail: names.join(","),
      });
    }

    // Ordering: the agent emits its lifecycle event only AFTER the app
    // relay on every runtime hook (kagero-first hooks do their pre-work
    // silently), so each k-th app hook log must precede the k-th agent
    // lifecycle event. Pairing by index catches an inversion in ANY
    // cycle — a plain "every app < some agent" would mask all but the
    // last one. Count equality is required too: a missed cycle is a
    // contract break, not a pairing gap.
    for (const hook of ["run", "suspend", "resume", "terminate"]) {
      const appIdxs = res.otlp
        .map((c, i) => (isAppHookLog(c, hook) ? i : -1))
        .filter((i) => i >= 0);
      const agentIdxs = res.otlp
        .map((c, i) => (isLifecycle(c, hook) ? i : -1))
        .filter((i) => i >= 0);
      const ok =
        appIdxs.length > 0 &&
        appIdxs.length === agentIdxs.length &&
        appIdxs.every((i, k) => i < (agentIdxs[k] ?? -1));
      checks.push({
        name: `app hook log precedes lifecycle event on /${hook}`,
        ok,
        detail: `app=${appIdxs.join("/")} agent=${agentIdxs.join("/")}`,
      });
    }

    // The app must be dead after /terminate — poll for a few seconds; a
    // single fetch races the SIGTERM on a loaded machine.
    let appDead = false;
    const deadDeadline = Date.now() + 3_000;
    while (Date.now() < deadDeadline) {
      try {
        await fetch(`http://127.0.0.1:${sim.ports.appHook}/__hooks`, {
          signal: AbortSignal.timeout(400),
        });
        await new Promise((r) => setTimeout(r, 150));
      } catch {
        appDead = true;
        break;
      }
    }
    checks.push({ name: "app is stopped after /terminate", ok: appDead });

    let agentAlive = false;
    try {
      const r = await fetch(`http://127.0.0.1:${sim.ports.admin}/healthz`, {
        signal: AbortSignal.timeout(800),
      });
      agentAlive = r.ok;
    } catch {
      agentAlive = false;
    }
    checks.push({ name: "agent survives /terminate (waits for container stop)", ok: agentAlive });
  } finally {
    await sim.teardown();
  }
  return { checks, ok: checks.every((c) => c.ok) };
}
