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
- **Agent**: the hook port and the admin port are bound before the app
  starts, so the app can no longer take either one first. A failed admin
  bind or accept is now logged instead of dropped silently.

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
