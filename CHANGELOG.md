# Changelog

All notable changes to kagero are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [Semantic Versioning](https://semver.org/) — no
compatibility guarantees while the version is 0.x (docs/roadmap.md).

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
