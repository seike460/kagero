/**
 * Drive the real kagero-agent binary as a child process. Captures stderr
 * (used in failure diagnostics) and exposes helpers for the admin
 * /healthz endpoint.
 */
import { type ChildProcess, spawn } from "node:child_process";

export interface AgentPorts {
  hook: number;
  appHook: number;
  otlp: number;
  admin: number;
}

export interface AgentHandle {
  /** stderr text so far. */
  stderr(): string;
  stop(signal?: NodeJS.Signals): void;
  exited: Promise<number | null>;
}

export interface SpawnAgentOptions {
  bin: string;
  /** argv for the app the agent should supervise (e.g. ["node","app.mjs"]). */
  appCommand: string[];
  ports: AgentPorts;
  env?: Record<string, string>;
}

export function spawnAgent(opts: SpawnAgentOptions): AgentHandle {
  // Ambient KAGERO_* vars in the developer's shell must not leak into the
  // agent — every KAGERO_* value the agent sees must come from `ports` or
  // the caller's explicit `env`.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("KAGERO_")) env[k] = v;
  }
  Object.assign(env, {
    KAGERO_HOOK_PORT: String(opts.ports.hook),
    KAGERO_APP_HOOK_PORT: String(opts.ports.appHook),
    KAGERO_OTLP_PORT: String(opts.ports.otlp),
    KAGERO_ADMIN_PORT: String(opts.ports.admin),
    RUST_LOG: "info",
    ...opts.env,
  });
  const proc: ChildProcess = spawn(opts.bin, ["--", ...opts.appCommand], {
    env,
    // stdout is intentionally NOT piped: the agent logs continuously and
    // an undrained pipe buffer would stall it once full (~64 KiB).
    stdio: ["ignore", "ignore", "pipe"],
  });
  // An async spawn failure (ENOENT etc.) emits 'error' then 'exit' —
  // without a listener it throws as an uncaught error before `exited`
  // resolves and before waitForAdmin can report the real cause.
  proc.on("error", () => {});
  const stderrBuf: Buffer[] = [];
  proc.stderr?.on("data", (c: Buffer) => stderrBuf.push(c));

  const exited = new Promise<number | null>((resolve) => {
    proc.on("exit", (code) => resolve(code));
  });

  return {
    stderr: () => Buffer.concat(stderrBuf).toString("utf8"),
    stop: (signal: NodeJS.Signals = "SIGTERM") => proc.kill(signal),
    exited,
  };
}

/** Poll GET /healthz until the admin endpoint answers or the budget ends. */
export async function waitForAdmin(adminPort: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${adminPort}/healthz`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(`agent admin endpoint did not come up within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
