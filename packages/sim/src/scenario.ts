/**
 * The full simulator scenario: spawn the real agent binary with a mock
 * OTLP collector and the test app, drive the lifecycle, and collect the
 * evidence needed to verify the hook contract. Used by both the CLI
 * (`kagero-sim run`) and the vitest E2E.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentHandle, spawnAgent, waitForAdmin } from "./agent.js";
import { runBody } from "./hooks.js";
import { type LifecycleReport, runLifecycle } from "./lifecycle.js";
import { type MockOtlp, type OtlpCapture, startMockOtlp } from "./mock-otlp.js";

export interface SimPorts {
  hook: number;
  appHook: number;
  admin: number;
}

export interface SimOptions {
  agentBin: string;
  /** Path to test-app.ts / test-app.js — spawned directly by node (Node >=24
   * strips erasable TypeScript types natively; no loader). */
  testAppPath: string;
  ports?: Partial<SimPorts>;
  suspendCycles?: number;
  suspendPauseMs?: number;
  runIdentity?: { microvmId: string; tenantId?: string; sessionId?: string };
  agentEnv?: Record<string, string>;
  appEnv?: Record<string, string>;
}

export interface SimResult {
  lifecycle: LifecycleReport;
  otlp: OtlpCapture[];
  appArrivals: { hook: string; at: number; microvmId?: string; runHookPayload?: unknown }[];
}

export interface SimHandle {
  agent: AgentHandle;
  otlp: MockOtlp;
  ports: Required<SimPorts> & { otlp: number };
  /** True when the agent drove a real collector binary
   * (KAGERO_SIM_COLLECTOR_BIN) — the mock then captures collector-PROCESSED
   * telemetry, proving the template's 3-level attribute stripping. */
  realCollector: boolean;
  run(): Promise<SimResult>;
  teardown(): Promise<void>;
}

/** Allocate the ephemeral ports + mock collector, spawn the agent and
 * wait for its admin endpoint. Caller drives hooks via `run()`. */
export async function startSim(opts: SimOptions): Promise<SimHandle> {
  if (!existsSync(opts.agentBin)) {
    throw new Error(
      `agent binary not found at ${opts.agentBin} — run \`cargo build -p kagero-agent\` first`,
    );
  }
  const otlp = await startMockOtlp(0);
  const dir = mkdtempSync(join(tmpdir(), "kagero-sim-"));
  // The app may be dropped to uid 65534 (root-mode agent) — it still has
  // to write its state file here.
  chmodSync(dir, 0o777);
  const stateFile = join(dir, "app-state.jsonl");
  // Ephemeral ports everywhere — concurrent runs must not collide.
  const taken = new Set<number>([otlp.port]);
  const free = async () => pickPort(taken);
  const ports = {
    hook: opts.ports?.hook ?? (await free()),
    appHook: opts.ports?.appHook ?? (await free()),
    admin: opts.ports?.admin ?? (await free()),
    otlp: otlp.port,
  };
  // Optional real-collector mode: KAGERO_SIM_COLLECTOR_BIN points at an
  // otelcol-contrib binary (needs >= v0.103 for the fixture's
  // `otlphttp` `encoding: json`; verified against v0.141). The agent
  // renders the secret-free fixture (fixtures/collector.yaml.tmpl), the
  // collector listens on a fresh port, and exports to the mock sink —
  // so every OTLP capture is post-pipeline evidence.
  const collectorBin = process.env.KAGERO_SIM_COLLECTOR_BIN;
  const collectorEnv: Record<string, string> = {};
  if (collectorBin) {
    const collectorRx = await free();
    const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
    collectorEnv.KAGERO_OTLP_PORT = String(collectorRx);
    collectorEnv.KAGERO_COLLECTOR_BIN = collectorBin;
    collectorEnv.KAGERO_COLLECTOR_START = "run";
    collectorEnv.KAGERO_COLLECTOR_ARGS =
      process.env.KAGERO_SIM_COLLECTOR_ARGS ?? '["--config","{config}"]';
    collectorEnv.KAGERO_COLLECTOR_CONFIG_TEMPLATE =
      process.env.KAGERO_SIM_COLLECTOR_TEMPLATE ??
      join(here, "..", "fixtures", "collector.yaml.tmpl");
    // Not in `dir`: the agent refuses to render into a directory the app
    // can write (0777 without the sticky bit).
    collectorEnv.KAGERO_COLLECTOR_CONFIG_OUT = join(
      mkdtempSync(join(tmpdir(), "kagero-sim-collector-")),
      "collector.yaml",
    );
    collectorEnv.KAGERO_OTLP_ENDPOINT_LGTM = `http://127.0.0.1:${otlp.port}`;
  }
  const agent = spawnAgent({
    bin: opts.agentBin,
    // Node >=24 strips erasable TypeScript types natively — the test app
    // runs without a loader or a build step.
    appCommand: [process.execPath, opts.testAppPath],
    ports,
    env: {
      APP_STATE_FILE: stateFile,
      KAGERO_BACKEND: "lgtm",
      // Sim drives hooks from loopback — the real deployment expects an
      // explicit allowlist; set it so the sim exercises the allow path
      // rather than relying on the empty-allowlist fallback.
      KAGERO_HOOK_ALLOWED_PEERS: "127.0.0.0/8,::1/128",
      // Exercise tenant/session extraction end-to-end: pointers navigate
      // inside runHookPayload (identity.rs strips the prefix), and the
      // body carries {tenant:{id},session}; in real-collector mode the
      // rendered resource/identity stamps them on log resources.
      KAGERO_TENANT_JSON_POINTER: "/tenant/id",
      KAGERO_SESSION_JSON_POINTER: "/session",
      ...collectorEnv,
      ...opts.agentEnv,
      // Env meant for the app itself (the agent passes it through; the
      // app inherits everything except AWS_* credential carriers).
      ...(collectorBin ? { KAGERO_SIM_HOSTILE_METRICS: "1" } : {}),
      ...opts.appEnv,
    },
  });
  try {
    await waitForAdmin(ports.admin);
    // And the app's hook port — the runtime only calls /ready once the
    // app is accepting hooks; racing it loses the early hooks to
    // NoListener (a real scenario covered separately, not the happy path).
    await waitForApp(ports.appHook);
  } catch (e) {
    agent.stop("SIGKILL");
    await otlp.close();
    throw new Error(`agent failed to start: ${(e as Error).message}\nstderr: ${agent.stderr()}`);
  }

  const run = async (): Promise<SimResult> => {
    const identity = opts.runIdentity ?? {
      microvmId: "sim-mvm-1",
      tenantId: "tenant-a",
      sessionId: "session-1",
    };
    const lifecycle = await runLifecycle({
      hookBase: `http://127.0.0.1:${ports.hook}`,
      runBody: runBody(identity),
      cycles: opts.suspendCycles ?? 2,
      suspendPauseMs: opts.suspendPauseMs ?? 300,
    });
    // Let the last hook's async OTLP posts land.
    await new Promise((r) => setTimeout(r, 300));
    const appArrivals = existsSync(stateFile)
      ? readFileSync(stateFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map(
            (l) =>
              JSON.parse(l) as {
                hook: string;
                at: number;
                microvmId?: string;
                runHookPayload?: unknown;
              },
          )
      : [];
    return {
      lifecycle,
      otlp: otlp.captures(),
      appArrivals,
    };
  };

  const teardown = async () => {
    // SIGTERM first — the agent forwards it to the app's process group and
    // exits within ~5s. SIGKILL only as the escape hatch, and SIGKILL on
    // the agent alone can NOT reach the app's own process group.
    agent.stop("SIGTERM");
    const exited = await Promise.race([
      agent.exited.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 8_000)),
    ]);
    if (!exited) agent.stop("SIGKILL");
    await otlp.close();
  };

  return { agent, otlp, ports, realCollector: !!collectorBin, run, teardown };
}

/** Bind :0, read the port, close — a free ephemeral port for the fixed
 * hook/app/admin sockets so concurrent sim runs don't share fixed ports.
 * The port is only free at pick time: another process can still bind it
 * before the agent or app does (a narrow window, not retried). Retries
 * when the OS hands back a port already claimed in `taken`. */
export async function pickPort(taken?: Set<number>): Promise<number> {
  for (;;) {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const addr = srv.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    await new Promise<void>((r) => srv.close(() => r()));
    if (port > 0 && !taken?.has(port)) {
      taken?.add(port);
      return port;
    }
  }
}

/** The test app exposes GET /__hooks; use it as the readiness signal —
 * equivalent to the runtime waiting for the app listener to accept. */
async function waitForApp(appHookPort: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${appHookPort}/__hooks`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(`test app did not come up within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
