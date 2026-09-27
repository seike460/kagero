/**
 * Lifecycle-hook client for the simulator. Mirrors the wire contract the
 * real Lambda MicroVM runtime uses:
 *   POST http://<host>:<hookPort>/aws/lambda-microvms/runtime/v1/<hook>
 * (docs/poc/02-hook-contract.md).
 */
export const HOOK_PATH = "/aws/lambda-microvms/runtime/v1/" as const;

export type HookName = "ready" | "validate" | "run" | "suspend" | "resume" | "terminate";

export interface HookResult {
  hook: HookName;
  status: number;
  body: unknown;
}

export interface RunHookBody {
  microvmId: string;
  runHookPayload?: unknown;
  [k: string]: unknown;
}

/** POST one hook with a client-side deadline. Throws on network errors
 * only — non-2xx statuses are data, not exceptions. */
export async function callHook(
  base: string,
  hook: HookName,
  body: unknown,
  timeoutMs: number,
): Promise<HookResult> {
  const res = await fetch(`${base}${HOOK_PATH}${hook}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Non-JSON body — keep the raw text.
  }
  return { hook, status: res.status, body: parsed };
}

/** Default /run body the runtime sends (microvms.md §5). */
export function runBody(opts: {
  microvmId: string;
  tenantId?: string;
  sessionId?: string;
}): RunHookBody {
  return {
    microvmId: opts.microvmId,
    runHookPayload: {
      tenant: opts.tenantId === undefined ? undefined : { id: opts.tenantId },
      session: opts.sessionId,
    },
  };
}
