import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { callHook, runBody } from "./hooks.js";
import { startMockOtlp } from "./mock-otlp.js";
import { pickPort } from "./scenario.js";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const hasPython = spawnSync("python3", ["--version"]).status === 0;

const apps = [
  { name: "node", cmd: process.execPath, script: "examples/node/app/index.mjs", ok: true },
  {
    name: "python",
    cmd: "python3",
    script: "examples/python/app/main.py",
    ok: hasPython || !!process.env.CI,
  },
];

async function waitForHealthz(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`app did not come up within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// The example apps start at image build, but the collector only exists
// from /run on (microvms.md §6) — they must not send anything before it.
describe.each(apps)("examples/$name app", ({ cmd, script, ok }) => {
  it.skipIf(!ok)("sends telemetry only from /run on", { timeout: 30_000 }, async () => {
    const otlp = await startMockOtlp(0);
    const hookPort = await pickPort(new Set([otlp.port]));
    const app = spawn(cmd, [join(repo, script)], {
      env: {
        ...process.env,
        KAGERO_OTLP_PORT: String(otlp.port),
        KAGERO_APP_HOOK_PORT: String(hookPort),
      },
      stdio: "ignore",
    });
    const exited = new Promise((r) => app.once("exit", r));
    try {
      await waitForHealthz(hookPort);
      const base = `http://127.0.0.1:${hookPort}`;
      expect((await callHook(base, "ready", {}, 5000)).status).toBe(200);
      expect((await callHook(base, "validate", {}, 5000)).status).toBe(200);
      expect(otlp.captures()).toEqual([]);
      const run = await callHook(base, "run", runBody({ microvmId: "ex-1" }), 5000);
      expect(run.status).toBe(200);
      expect(otlp.captures().map((c) => c.path)).toEqual(["/v1/logs"]);
    } finally {
      app.kill("SIGTERM");
      await exited;
      await otlp.close();
    }
  });
});
