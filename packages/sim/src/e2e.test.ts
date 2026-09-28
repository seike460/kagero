import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentBin, runE2E, testAppPath } from "./e2e.js";
import { callHook, type HookName, runBody } from "./hooks.js";
import { startSim } from "./scenario.js";
import { firstBadResult, hookStatuses } from "./verify.js";

// Needs the real binary (`cargo build -p kagero-agent`). Skipped when it
// is absent so pure-TS runs stay green — but never under CI, which builds
// it first: a missing binary there must fail, not skip silently.
describe.skipIf(!existsSync(agentBin) && !process.env.CI)("agent E2E", () => {
  it("drives a full lifecycle and verifies the contract", { timeout: 120_000 }, async () => {
    const { checks, ok } = await runE2E();
    for (const c of checks) {
      expect.soft(c.ok, `${c.name}${c.detail ? ` (${c.detail})` : ""}`).toBe(true);
    }
    expect(ok).toBe(true);
  });

  it("answers 2xx for a hook the app does not implement (404)", { timeout: 60_000 }, async () => {
    const sim = await startSim({
      agentBin,
      testAppPath,
      suspendCycles: 1,
      appEnv: { APP_HOOK_UNIMPLEMENTED: "suspend" },
    });
    try {
      const res = await sim.run();
      expect(firstBadResult(res.lifecycle.results)).toBeNull();
      expect(res.appArrivals.map((a) => a.hook)).toContain("suspend");
      expect(hookStatuses(res.otlp, "suspend")).toEqual(["unimplemented"]);
      expect(hookStatuses(res.otlp, "resume")).toEqual(["ok"]);
    } finally {
      await sim.teardown();
    }
  });

  it("answers before the hook deadline when the app is too slow", { timeout: 60_000 }, async () => {
    // A 2s /suspend budget, half of it left to the app; the app would
    // answer only after 10s.
    const sim = await startSim({
      agentBin,
      testAppPath,
      agentEnv: { KAGERO_HOOK_TIMEOUT_MS_SUSPEND: "2000", KAGERO_HOOK_RESERVE_FRACTION: "0.5" },
      appEnv: { APP_HOOK_DELAY_MS_SUSPEND: "10000" },
    });
    try {
      const base = `http://127.0.0.1:${sim.ports.hook}`;
      const call = (hook: HookName, body: unknown = {}) => callHook(base, hook, body, 15_000);
      expect((await call("ready")).status).toBe(200);
      expect((await call("validate")).status).toBe(200);
      expect((await call("run", runBody({ microvmId: "sim-mvm-1" }))).status).toBe(200);
      const started = performance.now();
      const suspend = await call("suspend");
      const elapsed = performance.now() - started;
      expect(suspend.status).toBe(502);
      expect(elapsed).toBeLessThan(3_000);
      expect((await call("resume")).status).toBe(200);
      expect((await call("terminate")).status).toBe(200);
    } finally {
      await sim.teardown();
    }
  });

  it("keeps answering hooks while the OTLP receiver is down", { timeout: 60_000 }, async () => {
    const sim = await startSim({ agentBin, testAppPath, suspendCycles: 1 });
    try {
      await sim.otlp.close();
      const res = await sim.run();
      expect(firstBadResult(res.lifecycle.results)).toBeNull();
      expect(res.appArrivals.map((a) => a.hook)).toEqual([
        "ready",
        "validate",
        "run",
        "suspend",
        "resume",
        "terminate",
      ]);
    } finally {
      await sim.teardown();
    }
  });
});
