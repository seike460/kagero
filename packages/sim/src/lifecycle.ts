/**
 * Drive a full MicroVM lifecycle against the agent's hook port, in the
 * order the real runtime uses (docs/design/microvms.md §4):
 *   ready → validate → run → (suspend → resume)×cycles → terminate
 */
import { callHook, type HookName, type HookResult, type RunHookBody } from "./hooks.js";

export interface LifecycleOptions {
  /** e.g. "http://127.0.0.1:2018" — the agent's hook endpoint. */
  hookBase: string;
  runBody: RunHookBody;
  /** suspend→resume iterations after run (default 1). */
  cycles?: number;
  /** Per-hook client timeout (default 15s, above the agent's 10s cap). */
  timeoutMs?: number;
  /** Pause between suspend and resume to let the suspend settle (ms). */
  suspendPauseMs?: number;
}

export interface LifecycleReport {
  results: HookResult[];
  sequence(): HookName[];
}

export async function runLifecycle(opts: LifecycleOptions): Promise<LifecycleReport> {
  const cycles = opts.cycles ?? 1;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const results: HookResult[] = [];

  const call = (hook: HookName, body: unknown = {}) =>
    callHook(opts.hookBase, hook, body, timeoutMs).then((r) => {
      results.push(r);
      return r;
    });

  await call("ready");
  await call("validate");
  await call("run", opts.runBody);
  for (let i = 0; i < cycles; i++) {
    await call("suspend");
    if (opts.suspendPauseMs) {
      await new Promise((r) => setTimeout(r, opts.suspendPauseMs));
    }
    await call("resume");
  }
  await call("terminate");

  return {
    results,
    sequence: () => results.map((r) => r.hook),
  };
}
