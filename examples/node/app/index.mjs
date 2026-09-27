/**
 * kagero example app — Node.js. This is the process the agent spawns
 * as PID 1's child inside the MicroVM (microvms.md §10):
 *
 *   ENTRYPOINT ["/usr/local/bin/kagero", "--"]
 *   CMD ["node", "/app/index.mjs"]
 *
 * It shows the three contracts an app opts into:
 *  1. OTLP out: telemetry goes to the in-MicroVM collector at
 *     127.0.0.1:$KAGERO_OTLP_PORT (default 4318, HTTP). Never to the
 *     backend directly — the collector stamps identity.
 *  2. Hook server: POST /aws/lambda-microvms/runtime/v1/<hook> on
 *     $KAGERO_APP_HOOK_PORT (default 2019), loopback only. The agent
 *     relays ALL hooks — ready/validate/run/resume/suspend/terminate;
 *     a 404 just means "unimplemented" and is safe. For suspend and
 *     terminate, answer 200 only after your telemetry has left the
 *     process — the agent's own flush runs after yours.
 *  3. Identity: runtime ids arrive in the /run hook body alongside
 *     runHookPayload; image metadata comes from env. The app never
 *     invents ids.
 */

import { Buffer } from "node:buffer";
import { createServer, request } from "node:http";

const OTLP = `http://127.0.0.1:${process.env.KAGERO_OTLP_PORT ?? 4318}`;
const HOOK_PORT = Number(process.env.KAGERO_APP_HOOK_PORT ?? 2019);
const HOOK_PATH = "/aws/lambda-microvms/runtime/v1/";

/** Minimal OTLP/HTTP log sender — real apps would use the OTel SDK.
 *  Returns a promise so the hook reply can wait for the write — on
 *  suspend/terminate the 200 IS the "telemetry has left" signal. */
function emitLog(body, hook) {
  const payload = JSON.stringify({
    resourceLogs: [
      {
        scopeLogs: [
          {
            scope: { name: "example-app" },
            logRecords: [
              {
                timeUnixNano: String(BigInt(Date.now()) * 1000000n),
                severityText: "INFO",
                body: { stringValue: body },
                attributes: [{ key: "app.hook", value: { stringValue: hook } }],
              },
            ],
          },
        ],
      },
    ],
  });
  const url = new URL("/v1/logs", OTLP);
  return new Promise((resolve) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
        timeout: 2000,
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
      },
    );
    // Telemetry must never crash or stall the app — resolve on ANY
    // outcome: response end, socket error, or premature close. Without
    // "close", a stalled collector would hang this promise and the hook
    // reply would burn the agent's whole relay budget.
    req.on("timeout", () => req.destroy());
    req.on("error", resolve);
    req.on("close", resolve);
    req.end(payload);
  });
}

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url?.startsWith(HOOK_PATH)) {
    const hook = req.url.slice(HOOK_PATH.length);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let payload;
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        payload = {};
      }
      // /run carries the ids beside runHookPayload; later hooks
      // carry {} — the app never invents ids itself.
      // (Payload logging is demo-only; drop it in real apps.)
      console.log(JSON.stringify({ msg: "hook", hook, payload }));
      // The collector is not started during build hooks — don't emit.
      const emits = hook !== "ready" && hook !== "validate";
      const flushed = emits ? emitLog(`hook ${hook} received`, hook) : Promise.resolve();
      flushed.finally(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    return;
  }
  if (req.url === "/healthz") {
    res.writeHead(200);
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(HOOK_PORT, "127.0.0.1", () => {
  console.log(JSON.stringify({ msg: "example app listening", hookPort: HOOK_PORT }));
});
