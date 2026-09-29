/**
 * Test application — the process the agent spawns and supervises. This
 * file is executed directly by Node as the agent's app_command:
 *   kagero-agent -- node <this-file>
 *
 * Behaviour (all env-configurable, MicroVM-app contract):
 * - serves the app's hook port: POST .../v1/<hook> records the arrival
 *   and replies 200 (or 404 when the hook is in APP_HOOK_UNIMPLEMENTED,
 *   or after APP_HOOK_DELAY_MS_<hook> for timeout experiments)
 * - on every hook arrival, emits one OTLP log to the mock collector
 *   tagged with the hook name — the ordering evidence the simulator
 *   uses to prove app-first vs kagero-first relay semantics
 * - GET /__hooks replays the arrival log; GET /__hooks.json for humans
 * - never exits on its own (terminate is what stops it)
 */
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const HOOK_PATH = "/aws/lambda-microvms/runtime/v1/";
const HOOK_PORT = Number(process.env.KAGERO_APP_HOOK_PORT ?? 2019);
const OTLP = `http://127.0.0.1:${process.env.KAGERO_OTLP_PORT ?? 4318}`;
const STATE_FILE = process.env.APP_STATE_FILE;
const UNIMPLEMENTED = new Set(
  (process.env.APP_HOOK_UNIMPLEMENTED ?? "").split(",").filter(Boolean),
);

interface Arrival {
  hook: string;
  at: number;
  microvmId?: string;
  /** The runHookPayload subtree as received — full-fidelity relay check. */
  runHookPayload?: unknown;
}

const arrivals: Arrival[] = [];

function record(a: Arrival): void {
  arrivals.push(a);
  // Persist too — the app's in-memory log dies with it on /terminate but
  // the simulator still needs the arrivals as evidence. Failure is not
  // fatal (e.g. the app was dropped to uid 65534 and can't write).
  if (STATE_FILE) {
    try {
      appendFileSync(STATE_FILE, `${JSON.stringify(a)}\n`, "utf8");
    } catch {
      // best effort
    }
  }
}

/** Flush-before-response: the post is AWAITED so the log lands at the
 * collector before the hook answer — that's the contract a compliant app
 * keeps (ADR-006) and it makes the ordering evidence deterministic. */
async function emitOtlp(kind: "logs" | "metrics" | "traces", body: unknown): Promise<void> {
  try {
    await fetch(`${OTLP}/v1/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // App must not crash when the collector is down.
  }
}

function hookLog(hook: string, microvmId?: string): unknown {
  const now = Date.now() * 1e6;
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "sim-app" } },
            // The app self-claims an identity — the collector is
            // responsible for overwriting it (threat model).
            { key: "service.instance.id", value: { stringValue: microvmId ?? "app-claimed" } },
          ],
        },
        scopeLogs: [
          {
            scope: { name: "sim-app" },
            logRecords: [
              {
                timeUnixNano: String(now),
                severityText: "INFO",
                body: { stringValue: `app hook ${hook}` },
                attributes: [
                  { key: "sim.hook", value: { stringValue: hook } },
                  { key: "sim.origin", value: { stringValue: "app" } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Hostile metric emitted once on /run when a REAL collector sits in the
 * pipeline (KAGERO_SIM_HOSTILE_METRICS=1, set by the sim's collector
 * mode): forbidden id-shaped attributes at resource, scope AND datapoint
 * level. If the collector's three-level stripping works, the mock sink
 * sees a clean metric; the e2e forbidden-keys check is the proof. Each
 * level also carries a harmless `sim.level` naming the level, which the
 * collector must keep — so a check can tell a stripped level from a
 * lost one. */
function hostileMetric(): unknown {
  const now = String(Date.now() * 1e6);
  const forbidden = [
    { key: "service.instance.id", value: { stringValue: "app-claimed" } },
    { key: "kagero.tenant.id", value: { stringValue: "app-claimed" } },
    { key: "kagero.session.id", value: { stringValue: "app-claimed" } },
  ];
  const level = (name: string) => [
    ...forbidden,
    { key: "sim.level", value: { stringValue: name } },
  ];
  return {
    resourceMetrics: [
      {
        resource: { attributes: level("resource") },
        scopeMetrics: [
          {
            scope: { name: "sim-app", attributes: level("scope") },
            metrics: [
              {
                name: "sim.app.hostile_gauge",
                gauge: {
                  dataPoints: [
                    {
                      timeUnixNano: now,
                      asInt: "1",
                      attributes: level("datapoint"),
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

function delayFor(hook: string): number {
  return Number(process.env[`APP_HOOK_DELAY_MS_${hook.toUpperCase()}`] ?? 0);
}

const server = createServer((req, res) => {
  const url = req.url ?? "";
  if (req.method === "GET" && url.startsWith("/__hooks")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(arrivals));
    return;
  }
  if (req.method !== "POST" || !url.startsWith(HOOK_PATH)) {
    res.writeHead(404).end("{}");
    return;
  }
  const hook = url.slice(HOOK_PATH.length);
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let microvmId: string | undefined;
    let runHookPayload: unknown;
    try {
      const parsed = JSON.parse(raw) as { microvmId?: string; runHookPayload?: unknown };
      microvmId = parsed.microvmId;
      runHookPayload = parsed.runHookPayload;
    } catch {
      // body may be absent/non-json
    }
    record({ hook, at: Date.now(), microvmId, runHookPayload });
    await emitOtlp("logs", hookLog(hook, microvmId));
    if (hook === "run" && process.env.KAGERO_SIM_HOSTILE_METRICS === "1") {
      await emitOtlp("metrics", hostileMetric());
    }
    const wait = delayFor(hook);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (UNIMPLEMENTED.has(hook)) {
      res.writeHead(404).end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
  });
});

server.listen(HOOK_PORT, "127.0.0.1", () => {
  console.log(JSON.stringify({ event: "sim_app.up", port: HOOK_PORT }));
});
