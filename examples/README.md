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

## A word on the hook port

The agent's hook port listens on all interfaces. With
`KAGERO_HOOK_ALLOWED_PEERS` unset, it rejects loopback peers only, so
the app can still forge hooks such as `/run` or `/terminate` by
connecting to the MicroVM's own IP. This risk stays open until PoC-02
confirms the addresses Lambda sends hooks from; then set them as the
allowlist (`hookAllowedPeers` in `KageroMicrovmImage`).

## Build

From the repo root (the collector template must be in context):

```sh
docker build --platform linux/arm64 -f examples/node/Dockerfile -t kagero-example-node .
docker build --platform linux/arm64 -f examples/python/Dockerfile -t kagero-example-python .
```

The images are arm64 only: the `al2023-minimal` base and the agent
image `ghcr.io/seike460/kagero:0.1` are published for `linux/arm64`
alone, so an x86_64 host needs QEMU emulation (binfmt).

To try agent changes that are not released yet, build the static
arm64 binary with the release Dockerfile — it lands at the context
root as `kagero` — and replace the `COPY --from=ghcr.io/seike460/kagero:0.1`
line with `COPY kagero /usr/local/bin/kagero`:

```sh
docker build --platform linux/arm64 -f docker/agent.Dockerfile -o . .
```

(`cargo build` on the host builds for the host: a binary built on
macOS or x86_64 does not run in the arm64 image.)

Each image pins `grafana/alloy:v1.20.0` as the collector with the
LGTM-only Alloy template. Set `KAGERO_OTLP_ENDPOINT_LGTM` to a real
endpoint — `https://otlp.invalid` is a placeholder that fails
visibly; pointing at `localhost:4318` would loop telemetry back into
the collector's own receiver. For CloudWatch, replace the collector:
copy in `otelcol-contrib` and `collector/cloudwatch/collector.yaml.tmpl`,
and set `KAGERO_BACKEND=cloudwatch`, `KAGERO_COLLECTOR_BIN` and
`KAGERO_COLLECTOR_ARGS` to match (see the spawn contract in
`collector/README.md`).

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
