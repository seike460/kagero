# Changelog

All notable changes to kagero are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [Semantic Versioning](https://semver.org/) — no
compatibility guarantees while the version is 0.x (docs/roadmap.md).

## [Unreleased]

### Changed

- **Agent**: startup now rejects more malformed configuration instead of
  misbehaving later. Endpoints (`KAGERO_OTLP_ENDPOINT*`,
  `KAGERO_ENDPOINT_CW_*`) may not contain `$` or a backtick, since they
  land in shell-sourced env files. `KAGERO_HOOK_PORT`,
  `KAGERO_APP_HOOK_PORT`, `KAGERO_OTLP_PORT`, `KAGERO_ADMIN_PORT` and the
  collector's fixed OTLP/gRPC port 4317 must all differ.
  `KAGERO_TENANT_JSON_POINTER` / `KAGERO_SESSION_JSON_POINTER` must be
  RFC 6901 pointers, and `KAGERO_MICROVM_BASELINE_GIB` /
  `KAGERO_MICROVM_BASELINE_VCPU` must be positive finite numbers.
- **CDK**: `KageroMicrovmImage` applies the same endpoint, JSON Pointer
  and `hookPort` checks at synth time.
- **CDK**: `KageroMicrovmImage` rejects a `hookAllowedPeers` entry that
  is not an IP or CIDR at synth time. The agent already refused such an
  entry at boot.
- **CDK**: the default dead-letter queue of `KageroDurableStitcher` now
  denies requests that do not use TLS (`enforceSSL`).
- **Agent**: the hook port and the admin port are bound before the app
  starts, so the app can no longer take either one first. A failed admin
  bind or accept is now logged instead of dropped silently.
- **k6 runner**: a shard refuses a `startAtMs` that is missing or not a
  finite number instead of starting at once with a `NaN` skew. The
  default limit on how far ahead `startAtMs` may be is now 10 minutes
  (was 15). The wait and the k6 run share one invocation, and a
  15-minute wait left no time for k6 within the Lambda timeout.
- **k6 runner**: `scriptPath` must be a file inside the worker. A URL
  (other than `file:`) or `-` (stdin) is refused before the wait. k6
  runs `https://` scripts, so whoever could start an execution could
  run their own script with the worker role's credentials, which k6
  exposes through `__ENV`. The script path now follows `--`, so
  `extraArgs` can no longer replace the script either.
- **Image**: the build stage pins `rust:1.98.1-alpine3.24` by digest, so
  rebuilding a tag uses the same Alpine and musl.

### Fixed

- **Agent**: the hook relay, the loopback OTLP export, the collector
  reload call and the credential lookups (IMDS / container credentials)
  no longer go through `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`, and
  the hook relay no longer follows redirects returned by the app. Only
  the Secrets Manager call still honors the proxy settings.
- **Agent**: `kagero.microvm.hook_results` now labels `kagero.hook.status`
  with every registry value. A hook the app does not answer within its
  budget is `timeout`, and an app that returns 404 or does not listen is
  `unimplemented`. Before, the agent sent only `ok` / `error`, so a 404
  counted as `ok` and a timeout as `error`.
- **Agent**: a deliberate collector restart (for example `/resume`
  without `KAGERO_COLLECTOR_RELOAD_URL`) no longer logs the old process
  as `child exited on its own`.
- **Agent**: the `kagero starting` log masks the userinfo
  (`user:password@`) of endpoint URLs.
- **Agent**: with `KAGERO_COLLECTOR_START=build` and `KAGERO_SECRET_ARN`
  both set, the collector now waits for `/run` as documented. Before, the
  build-time start failed and logged a `kagero.lifecycle.degraded` event
  on every build.
- **Agent**: a collector or app spawn whose exec fails can no longer
  abort PID 1. The reaper thread could reap the failed child before the
  spawn waited for it.
- **Agent**: `kagero.usage.running_seconds` no longer counts suspended
  time. The first sample after `/resume` now counts from the resume, not
  from the last sample before the suspend.
- **Agent**: a tenant or session id with no allowed character left
  (ASCII letters, digits and `._-@:/+=`) is omitted instead of being
  sent as an empty `kagero.tenant.id` / `kagero.session.id`.
- **CDK**: `KageroDurableStitcher` with `backend` `cloudwatch` or `both`
  now grants its role `xray:PutTraceSegments`, `xray:PutSpans` and
  `cloudwatch:PutMetricData`. Before, AWS denied every export to the
  CloudWatch OTLP endpoints. Traces to X-Ray also need Transaction Search
  enabled in the account.
- **CDK**: a Secrets Manager ARN passed as a token (for example
  `secret.secretArn`) is now granted as a complete ARN. Before, the grant
  added a `-??????` suffix that never matched, so `GetSecretValue` was
  denied at runtime (`KageroDurableStitcher`, `KageroK6Run`).
- **Simulator**: `kagero-sim run` from the built package (`dist/cli.js`)
  now starts the test app. Before, it looked for `test-app.ts` next to the
  compiled files and failed before the first hook.
- **Durable stitcher**: fetching the execution history no longer throws a
  `TypeError` on every notification. The SDK client's `send` was called
  without its client, so the stitcher never exported a trace or a metric.
- **Durable stitcher**: `KAGERO_OTLP_HEADER` (the LGTM credential,
  `otlpHeaderSecretArn` in CDK) now goes to the LGTM target only. Before,
  it was also sent to the CloudWatch endpoints, where it broke the SigV4
  signature, so every CloudWatch export failed.
- **k6 runner**: with the `cloudwatch` backend (EMF), a shard no longer
  sends the k6 JSON output that an earlier shard left in `/tmp`. A warm
  execution environment keeps the file, and k6 does not touch it when it
  fails before opening its output (a script error, for example). The old
  points went out under the new run and shard ids.
- **k6 runner**: the Grafana annotation POST now gives up after 5
  seconds (`timeoutMs` on `GrafanaAnnotations` changes it). Shard 0
  returns its result only after this POST, so a Grafana that stopped
  answering held the shard for up to 300 seconds (the fetch default) and
  could push it past the Lambda timeout.
- **Dashboards**: the CloudWatch dashboard's `KAGERO_PLATFORM_LOG_GROUP`
  variable now defaults to `/aws/lambda-microvms/<image-name>`, the log
  group where MicroVMs write stdout by default. It showed the Lambda
  function form `/aws/lambda/<function-name>`.
- **Dashboards**: the degraded-events panel and the
  `KageroDegradedLifecycle` alert no longer say that they count app
  relay failures. Only kagero's own steps (a secret fetch, the
  collector, an OTLP export, and so on) raise a degraded event. App relay
  failures and timeouts are counted by `kagero.microvm.hook_results`.
- **Dashboards**: the `KageroNoMicrovmTelemetry` alert now says that it
  also fires when no MicroVM is RUNNING, for example when the whole
  fleet is suspended. It fits fleets that should always be active.
- **Dashboards**: the dashboard description no longer mentions traces
  or suspend/resume latency. The agent emits no spans, and the suspend
  panel shows how long MicroVMs stayed suspended.
- **Collector**: the CloudWatch templates (OTel Collector and Rotel) now
  send logs to the log stream `otlp` in the log group
  `/kagero/<image-name>`. The CloudWatch Logs OTLP endpoint writes only
  to a log group and stream that already exist (AWS documentation). The
  stream was named after the MicroVM id, which is known only at `/run`,
  so it could not be created in advance and every log export would be
  rejected. Create the group and the stream before the first `/run`,
  as `collector/README.md` now describes. On the Rotel path, logs no
  longer carry the MicroVM id.
- **Pricing**: the MicroVM prices now apply from 2026-06-22, the day
  MicroVMs launched. They applied from 2026-06-09, so an `asOf` before
  the launch still got a MicroVM price.
- **Image**: `ghcr.io/seike460/kagero` now carries kagero's `/LICENSE`
  and, under `/licenses`, the license texts of the crates and the Rust
  standard library built into the binary. It held only the binary,
  without the notices that the MIT, ISC and BSD licenses of those
  crates require.
- **Docs**: the k6 runner (`outputFromEnv`) and `KageroK6Run` now list
  the worker env and its values. There, `KAGERO_OTLP_ENDPOINT` is
  `host:port` with no scheme and `KAGERO_OTLP_HEADERS` is
  `k1=v1,k2=v2`, both in k6's own format. The agent and the durable
  stitcher take a URL under the same endpoint name, and the stitcher's
  header env is `KAGERO_OTLP_HEADER` as `Name: value`.
- **Docs**: the README now says that the durable stitcher sends its
  `kagero.durable.*` metrics with delta temporality, and that an LGTM
  backend has to convert them to cumulative. A Prometheus without the
  `otlp-deltatocumulative` feature flag or a default Mimir does not
  ingest them.
- **Examples**: the Python example app no longer sends an OTLP log when
  it starts. The app starts during the image build, before the
  collector runs, and nothing may be sent at build time.
- **Docs**: the examples README and Dockerfiles build with
  `--platform linux/arm64` and say that the images are arm64 only. The
  stale "until v0.1 is published" notes are gone. To try unreleased
  agent changes, they now build the binary with `docker/agent.Dockerfile`,
  because `cargo build` on macOS or x86_64 makes a binary that the arm64
  image cannot run.
- **Docs**: the examples README no longer suggests
  `KAGERO_OTLP_ENDPOINT_CLOUDWATCH` for the example images, which ship
  the LGTM-only Alloy template. It now says what switching to CloudWatch
  takes.
- **Docs**: `kagero.env.example` keeps its comments on their own lines
  and says how to load it. With `docker run --env-file`, a comment after
  a value became part of the value, and the agent refused to start.
- **Docs**: the READMEs, the examples, `kagero.env.example`, the
  `hookAllowedPeers` JSDoc, the threat model and PoC-02 now say that with
  `KAGERO_HOOK_ALLOWED_PEERS` unset, the app can forge hooks such as
  `/terminate` by connecting to the MicroVM's own IP. The agent's startup
  warning says so too. The risk stays open until PoC-02 confirms the
  addresses Lambda sends hooks from.
- **Docs**: `collector/README.md` now lists the execution-role
  permissions that the CloudWatch backend needs: `logs:PutLogEvents`,
  `cloudwatch:PutMetricData`, `xray:PutTraceSegments` and
  `xray:PutSpans`, plus Transaction Search for traces. No document named
  them before.

## [0.1.0] — 2026-09-28

MicroVMs preview release. Implementation preceded the PoC gate — see
ADR-012 (docs/decisions.md). AWS-backed verification (PoC-01…05) is
still pending; everything below is verified by unit tests and the
simulator E2E, not on real AWS yet.

### Added

- **Agent** (`crates/kagero-agent`, Rust): PID-1 process inside a
  Lambda MicroVM. Relays the runtime hooks (`ready`, `validate`,
  `run`, `suspend`, `resume`, `terminate`) to the app, supervises the
  collector, resolves Secrets Manager secrets at runtime, and reports
  usage + lifecycle telemetry over OTLP/JSON with a JSON-lines stdout
  fallback that never blocks the workload (ADR-004).
- **Collector configs** (`collector/`): OTel Collector templates for
  LGTM and CloudWatch, an Alloy template for LGTM, and Rotel env
  templates — all rendered on `/run` with fail-closed placeholders and
  three-level (resource / datapoint / scope) forbidden-attribute
  stripping (ADR-008).
- **Semantic conventions** (`semconv/` + `packages/semconv`): the YAML
  registry is the source of truth; Rust and TypeScript constants plus
  the attribute reference doc are generated from it.
- **Simulator** (`packages/sim`): drives the real agent binary through
  the full hook lifecycle against a mock OTLP collector and asserts
  the observable contract (hook order, app-first relay, no forbidden
  metric labels, monotonic cumulative sums).
- **Pricing** (`packages/pricing`): versioned unit-price tables and
  cost formulas for the four products (estimates only — ADR-009).
- **Dashboards** (`packages/dashboards`): one spec compiled to Grafana
  dashboard JSON and alert rule files for both backends, via the
  Grafana Foundation SDK.
- **Durable stitcher** (`packages/durable-stitcher`): EventBridge
  status-change notifications → `GetDurableExecutionHistory` → a
  deterministic trace + metrics, fanned out to one or both backends.
- **k6 runner** (`packages/k6-runner`): Distributed Map sharding,
  per-shard results, EMF and OTLP output, Grafana annotations.
- **CDK constructs** (`packages/cdk`): `KageroMicrovmImage`,
  `KageroDurableStitcher`, `KageroK6Run`.
- **Examples** (`examples/`): Node.js and Python MicroVM images with
  hook-aware sample apps and the full env contract.
- **CI** (`.github/workflows/`): Rust gates, TypeScript gates,
  generated-artifact drift check, example syntax check.
- **Release** (`.github/workflows/release.yml`): tag `v*` publishes
  `ghcr.io/seike460/kagero` (arm64) with `0.x.y` + `0.x` tags.

### Not in this release (roadmap "入れないもの" / pending verification)

- Real AWS verification: MicroVM timeouts, credential reachability,
  billing figures, snapshot behavior (PoC-01…05).
- Grafana 13 / Amazon Managed Grafana 12.4 dashboard load check.
- Function-level dashboards/alerts, eBPF, fleet view, cost preview.
