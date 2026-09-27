"""
kagero example app — Python. The process the agent spawns as PID 1's
child inside the MicroVM (microvms.md §10):

    ENTRYPOINT ["/usr/local/bin/kagero", "--"]
    CMD ["python3", "/app/main.py"]

Same three contracts as the Node example:
 1. OTLP out → 127.0.0.1:$KAGERO_OTLP_PORT (never the backend directly).
 2. Hook server on $KAGERO_APP_HOOK_PORT —
    POST /aws/lambda-microvms/runtime/v1/<hook>.
 3. Runtime ids arrive in runHookPayload; the app never invents them.
"""

import json
import os
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OTLP = f"http://127.0.0.1:{os.environ.get('KAGERO_OTLP_PORT', '4318')}"
HOOK_PORT = int(os.environ.get("KAGERO_APP_HOOK_PORT", "2019"))
HOOK_PATH = "/aws/lambda-microvms/runtime/v1/"


def emit_log(body: str, hook: str) -> None:
    """Minimal OTLP/HTTP log send — real apps would use the OTel SDK."""
    payload = json.dumps(
        {
            "resourceLogs": [
                {
                    "scopeLogs": [
                        {
                            "scope": {"name": "example-app"},
                            "logRecords": [
                                {
                                    "timeUnixNano": str(time.time_ns()),
                                    "severityText": "INFO",
                                    "body": {"stringValue": body},
                                    "attributes": [
                                        {"key": "app.hook", "value": {"stringValue": hook}}
                                    ],
                                }
                            ],
                        }
                    ]
                }
            ]
        }
    ).encode()
    try:
        req = urllib.request.Request(
            f"{OTLP}/v1/logs",
            data=payload,
            headers={"content-type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=2).read()
    except Exception:
        pass  # telemetry must never crash the app


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802
        if not self.path.startswith(HOOK_PATH):
            self.send_response(404)
            self.end_headers()
            return
        hook = self.path[len(HOOK_PATH) :]
        length = int(self.headers.get("content-length") or 0)
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            payload = {}
        # (Payload logging is demo-only; drop it in real apps.)
        print(json.dumps({"msg": "hook", "hook": hook, "payload": payload}), flush=True)
        # The collector is not started during build hooks — don't emit.
        if hook not in ("ready", "validate"):
            emit_log(f"hook {hook} received", hook)
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b"{}")

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, *_args) -> None:  # keep stdout as JSON only
        pass


if __name__ == "__main__":
    print(json.dumps({"msg": "example app listening", "hookPort": HOOK_PORT}), flush=True)
    emit_log("app started", "boot")
    ThreadingHTTPServer(("127.0.0.1", HOOK_PORT), Handler).serve_forever()
