# kagero examples

Two minimal MicroVM images showing the app-side contract
(docs/design/microvms.md §10). Neither is meant for production load —
they exist so you can see exactly what an app does, and does not, own.

- `node/` — Node.js app (`index.mjs`, zero dependencies)
- `python/` — Python app (`main.py`, stdlib only)
- `kagero.env.example` — the non-secret environment contract, matching
  both `KageroMicrovmImage` (packages/cdk) and the agent's `config.rs`

## The three contracts an app opts into

1. **OTLP out.** Telemetry goes to the in-MicroVM collector at
   `127.0.0.1:$KAGERO_OTLP_PORT` (default 4318, HTTP) — never directly
   to the backend. The collector stamps identity attributes; the app
   must not send `kagero.*` identity values itself (they are
   overwritten).
2. **Hook server, loopback only.** `POST
   /aws/lambda-microvms/runtime/v1/<hook>` on
   `127.0.0.1:$KAGERO_APP_HOOK_PORT` (default 2019). The agent relays
   **every** hook — `ready`/`validate` at image build and
   `run`/`resume`/`suspend`/`terminate` at runtime — so accept all six
   paths or return 404 (unimplemented is safe). For `suspend` and
   `terminate` the app is called *first*: reply 200 only after your
   telemetry has actually left the process — the agent's own flush
   runs after yours.
3. **Identity arrives, never invented.** `run` carries the ids
   alongside `runHookPayload`; image metadata comes from env. Later
   hooks carry `{}`. Secrets never appear in the payload or image env
   (ADR-011) — set `KAGERO_SECRET_ARN` and the agent resolves it at
   `run` from Secrets Manager.

## A word on credentials

The shipped LGTM Alloy template needs a basic-auth pair and **fails
closed without it**: set `KAGERO_SECRET_ARN` to a Secrets Manager
secret containing JSON `{"username":"...","password":"..."}` or the
collector never exports (you'd only see a `kagero.lifecycle.degraded`
event). For auth-free local testing, swap in a template without
`otelcol.auth.basic` — see `collector/README.md`.

## Build

`COPY --from=ghcr.io/seike460/kagero:0.1` needs the published image —
until v0.1 is out, build the agent locally and copy it into context
(`cargo build --release && cp target/release/kagero kagero`), then
switch that line to `COPY kagero /usr/local/bin/kagero`
(`target/` is dockerignored, so the binary must sit at context root).

Then, from the repo root (the collector template must be in context):

```sh
docker build -f examples/node/Dockerfile -t kagero-example-node .
docker build -f examples/python/Dockerfile -t kagero-example-python .
```

Each image pins `grafana/alloy:v1.20.0` as the collector. Set
`KAGERO_OTLP_ENDPOINT_LGTM` (or `_CLOUDWATCH`) to a real endpoint —
`https://otlp.invalid` is a placeholder that fails visibly; pointing
at `localhost:4318` would loop telemetry back into the collector's
own receiver.

## Deploy

A `AWS::Lambda::MicrovmImage` code artifact is a zip of the
Dockerfile + build context — Lambda runs the image build itself.
`KageroMicrovmImage` (packages/cdk) emits the matching `Hooks.Port`,
hook timeouts, and `KAGERO_*` env vars from the same contract; use
`kagero.env.example` if you write the env yourself.

## Local check without AWS

`packages/sim` drives the real agent binary against a mock collector
(`pnpm --filter @kagero/sim test`) — the same hook ordering and flush
contract these apps rely on, verified end to end.
