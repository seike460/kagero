# kagero

A Grafana-first observability kit for the AWS Lambda family — Lambda MicroVMs, Lambda functions, Durable Functions, and k6 load testing — with both LGTM and Amazon CloudWatch as backends.

**Status: preview.** v0.1.0 (MicroVMs preview) was released on 2026-09-28. The agent is published as the container image `ghcr.io/seike460/kagero` (linux/arm64); the TypeScript packages are not on npm, so use them from a checkout of this repository. The modules below are implemented and pass CI (unit tests, simulator E2E against the real agent binary, typecheck, lint, and generated-artifact checks), but **the AWS-backed PoCs have not been run yet** — real-AWS behavior (timeout values, credential reach, actual pricing, snapshot semantics) is unverified. The deviation from the PoC-first rule is recorded in [ADR-012](docs/decisions.md). See the [roadmap](docs/roadmap.md) and the [changelog](CHANGELOG.md).

[日本語版 README](README.ja.md)

## Why

- **Lambda MicroVMs ship with almost no observability.** Launched on 2026-06-22, MicroVMs officially provide CloudWatch Logs, CloudTrail, and a `stateReason` field. There are no metrics, no OpenTelemetry integration, and no Grafana guidance. Snapshot-based startup and suspend/resume also break common telemetry assumptions: every clone starts from the same memory state, and data buffered before a suspend can be lost.
- **Grafana's Lambda dashboards are stuck on the CloudWatch API.** All seven Lambda dashboards on grafana.com rely on `GetMetricData`. None use OpenTelemetry, PromQL, Loki, or Tempo, and none show cost. Meanwhile, Lambda bills the INIT phase since 2025-08-01, and CloudWatch supports OTLP ingestion and PromQL since 2026-06-16.
- **New execution models need new views.** Lambda Managed Instances and Durable Functions change what "one invocation" means. Open-source tooling has not caught up, while commercial vendors offer computed signals such as estimated cost and cold-start tracking.

The full research, with sources, is in [docs/research/2026-09-landscape.md](docs/research/2026-09-landscape.md) (Japanese).

## Modules

| Module | What it does | Target | Implementation |
|---|---|---|---|
| A. MicroVMs | A small Rust agent, `kagero`, runs as the container entrypoint. It relays lifecycle hooks in a fixed order, gives each MicroVM its own identity, flushes telemetry before suspend and terminate, and records usage for cost estimation. | v0.1 (preview) | `crates/kagero-agent` — implemented; verified by simulator E2E, pending real-AWS PoC |
| B. Functions | Dashboards and alerts built on PromQL and OpenTelemetry, plus cold-start and INIT cost analytics. Also covers Managed Instances. | v0.2 | `packages/dashboards` + `packages/pricing` — MicroVM overview dashboard (both backends) and alerts (LGTM only; for CloudWatch a manifest marks them not supported) implemented and generated in CI; the function-level dashboard/alert MVP from `docs/design/functions-durable-k6.md` is **not built yet** |
| D. Durable Functions | Stitches a durable execution, including its replays, into a single trace for Tempo or X-Ray. | v0.3 (experimental) | `packages/durable-stitcher` — implemented; API shapes verified against AWS docs, pending real events |
| C. k6 | Runs k6 at scale on Lambda functions (shards of up to 15 minutes) and MicroVMs (up to 8 hours), and ships results to your backend. | v0.4 (experimental) | `packages/k6-runner` — framework implemented (Distributed Map sharding, EMF/OTLP/annotation output); the MicroVM launcher path for long runs is **not built yet**; pending real runs. k6 itself (AGPL-3.0) is not bundled — add a layer to the `KageroK6Run` worker that provides `bin/k6` and the test script |

Supporting pieces: `packages/sim` (hook simulator driving the real agent), `packages/secrets` (Secrets Manager resolution), `packages/cdk` (`KageroMicrovmImage`, `KageroDurableStitcher`, `KageroK6Run`), `collector/` (Alloy and OTel templates for LGTM and CloudWatch), `semconv/` + `packages/semconv` (attribute registry and the generator that emits Rust and TypeScript constants), `examples/` (Node.js and Python MicroVM images).

**Known limitation:** while two or more MicroVMs of one image run at once, the dashboard's metric panels overshoot, and so does the cost estimate. ADR-008 keeps ids off metric labels, so the MicroVMs' cumulative counters share one series, and `rate()` / `increase()` read the mix as counter resets. PoC-05 decides the fix.

## Backends

kagero supports both backends from day one. `KAGERO_BACKEND=both` exports to both from the durable-stitcher Lambda; for in-MicroVM collectors `both` requires a custom collector template — the shipped templates are single-backend (see `collector/README.md`).

The durable stitcher sends its metrics (`kagero.durable.*`) with delta temporality, because it keeps no state between executions. An LGTM backend has to convert them to cumulative: Prometheus does so only with the experimental `otlp-deltatocumulative` feature flag, and Mimir rejects delta metrics by default. For such a backend, put a collector with the `deltatocumulative` processor in front of it. PoC-05 and PoC-08 check the real backends.

| | LGTM | Amazon CloudWatch |
|---|---|---|
| Ingest | OTLP to Grafana Cloud, or to self-hosted Loki, Tempo, and Mimir | OTLP over HTTPS with SigV4 |
| Metrics | PromQL (Prometheus data source) | PromQL (Amazon Managed Prometheus data source with `sigv4Service=monitoring`) |
| Logs | LogQL | CloudWatch Logs Insights |
| Traces | TraceQL | X-Ray / Application Signals |

Generated dashboards use the v1 JSON model so that they work on Grafana 13, Grafana Cloud, and Amazon Managed Grafana 12.4.

## Design principles

1. **Quiesce at build, arm on `/run`.** Nothing unique (IDs, random seeds, connections, secrets) is created before the snapshot.
2. **Relay hooks in a fixed order.** One supervisor relays each hook, and the agent never blocks the workload at runtime.
3. **Guarantee flush with synchronous export,** not by polling queue metrics.
4. **Keep IDs off metric labels.** MicroVM, tenant, and session IDs go on logs and traces only.
5. **Report usage facts, apply prices at query time.** Costs are always labeled as estimates and reconciled against the AWS Cost and Usage Report.
6. **One spec, two backends.** A single dashboard spec renders for both backends. Anything a backend cannot show is marked as not supported instead of being silently dropped.
7. **No secrets in image environment variables.** Secrets are fetched at `/run` with the execution role.
8. **Assume untrusted code runs next to the agent.** Remaining risks are listed in the [threat model](docs/design/architecture.en.md#9-threat-model) — for example, until `KAGERO_HOOK_ALLOWED_PEERS` is set, the app can forge hooks through the MicroVM's own IP.

## Languages

- **Inside the MicroVM: Rust** (the `kagero` agent only). It keeps the memory and snapshot footprint small, ships as a single static binary for any image, and controls processes and capabilities directly.
- **Everywhere else: TypeScript on Node.js 24.** This covers the control-plane Lambda functions, AWS CDK constructs, dashboard generation with the Grafana Foundation SDK, and the hook simulator.

## Use

The agent is published as the `linux/arm64` image `ghcr.io/seike460/kagero`. Each release gets its version and minor tags (`0.1.0` and `0.1` for v0.1.0), and `latest` moves with each release. Copy the binary into your MicroVM image and make it the entrypoint, with your app as its command:

```dockerfile
FROM public.ecr.aws/lambda/microvms:al2023-minimal
COPY --from=ghcr.io/seike460/kagero:0.1 /kagero /usr/local/bin/kagero
COPY . /app
ENTRYPOINT ["/usr/local/bin/kagero", "--"]
CMD ["/app/start"]
```

A working image also needs a collector, its config template, and the agent's settings. [`examples/`](examples/README.md) has complete Node.js and Python images, and [`examples/kagero.env.example`](examples/kagero.env.example) lists the settings. The agent image also carries `/LICENSE` and `/licenses`, the license texts of the code built into the binary; copy them as well when you distribute your image.

## Develop

Toolchain versions are pinned with [mise](https://mise.jdx.dev/).

```sh
mise install          # node 24, pnpm, rust
pnpm install
pnpm build            # builds packages (needed before tests)
cargo build -p kagero-agent  # needed for the simulator E2E
pnpm test             # unit tests + simulator E2E
# Optional: run the E2E through a REAL otelcol-contrib binary to verify
# collector-side attribute stripping end to end:
KAGERO_SIM_COLLECTOR_BIN=/path/to/otelcol-contrib pnpm --filter @kagero/sim sim:e2e
# The same binary also runs the shipped collector/lgtm and
# collector/cloudwatch templates through the vitest suite:
KAGERO_SIM_COLLECTOR_BIN=/path/to/otelcol-contrib pnpm --filter @kagero/sim test
pnpm lint && pnpm typecheck
cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings
pnpm generate         # regenerates semconv constants + dashboards
```

## Documentation

| Document | Contents |
|---|---|
| [Architecture](docs/design/architecture.en.md) | Goals, backends, attributes and cardinality, dashboard spec, cost model, threat model, testing, releases |
| [MicroVMs design](docs/design/microvms.en.md) | Hook relay, quiesce and arm, flush, identity, usage recording |
| [Functions, Durable, and k6 design](docs/design/functions-durable-k6.en.md) | Data paths per backend, MVP scope, open questions |
| [Decisions (ADRs)](docs/decisions.en.md) | Accepted and proposed architecture decisions |
| [Roadmap](docs/roadmap.en.md) | Milestones, acceptance criteria, and what is out of scope |
| [PoC runbooks](docs/poc/README.en.md) | Experiments on real AWS, with guardrails and teardown checklists |
| [Research](docs/research/2026-09-landscape.md) | Landscape research as of 2026-09 (Japanese) |

Design docs are written in Japanese (the canonical versions, `*.md`);
English translations live beside them as `*.en.md`. The PoC index has
an English translation, but the individual PoC runbooks
(`docs/poc/0*.md`) and the research notes are still Japanese-only.

## Non-goals

- Running Grafana itself on Lambda
- A data source plugin that invokes Lambda functions
- AI-driven incident response ("AI SRE")
- A custom Lambda extension before v1.0

## Name

*Kagerō* (蜉蝣) is the Japanese word for the mayfly, an insect known for its short life. The name nods to short-lived compute: functions that live for seconds and MicroVMs that live for hours.

## Disclaimer

kagero is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by Amazon Web Services or Grafana Labs. AWS, AWS Lambda, Amazon CloudWatch, Grafana, Loki, Tempo, Mimir, and k6 are trademarks of their respective owners.

## License

[Apache License 2.0](LICENSE)

Maintained by [seike460](https://github.com/seike460).
