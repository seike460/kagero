# Roadmap

> English translation of [roadmap.md](roadmap.md) (Japanese is canonical). Last synced: 2026-09-27.

- Last updated: 2026-09-26
- Related documents: [Overall design](design/architecture.en.md) / [ADR](decisions.en.md) / [PoC](poc/README.en.md)

## Principles

- Ship early. The goal is to release MicroVMs v0.1 before AWS ships official metrics.
- Verify with PoCs before building. Write no implementation code until the M0 PoC gate is passed (the record of the implementation that ran ahead is in [ADR-012](decisions.en.md)).
- Decide "exclusions" for each stage, to keep the scope maintainable by one person.
- Do not build shared components ahead of need. Grow them into the shape that A and B actually require.
- Keep C and D experimental until v1.0.

## Stages

| Stage | Target timing | Acceptance criteria | Exclusions |
|---|---|---|---|
| M0 PoC gate | 3–4 weeks | Record the results of PoC-01–05. Decide the status of ADR-004–008 and ADR-011. Cleanup leaves zero AWS resources | Implementation code in general (implementation already ran ahead; [ADR-012](decisions.en.md)) |
| v0.1 MicroVMs preview | Before re:Invent 2026 (typically late November to early December) | Meets the "v0.1 acceptance criteria" below | eBPF, cost, fleet view, CDK constructs, alerts |
| v0.2 Lambda functions | TBD | Output for both backends from a single spec. INIT cost matches the formula within ±1%. Detects OOM and timeouts. Provides 6–8 alerts. Publishes 2 dashboards on grafana.com | Custom Lambda extension |
| v0.3 Durable (experimental) | TBD | For every completed execution, a trace with a root span appears in both Tempo and X-Ray. The replay count is visible. Stitching the same execution again produces the same result | Incremental stitching during execution |
| v0.4 k6 (experimental) | TBD | With 50+ shards, start skew is within 2 seconds. Results appear on both backends. Tests of 30+ minutes can run on MicroVMs | UI, browser-based tests |
| v0.5 | TBD | MicroVMs cost estimation matches CUR within ±5%. Adds fleet view, eBPF (opt-in), and CDK constructs | — |
| v1.0 | TBD | Freeze the API. Publish the support matrix. Send PRs upstream | — |

### v0.1 acceptance criteria

1. At least 99.9% of the telemetry sent just before stop/termination reaches both backends (20 trials each).
2. Every span and log carries the MicroVM ID.
3. No trace ID collisions across 10 instances launched from the same image.
4. Hook processing time stays within the budget decided in the PoCs.
5. App processing does not stop even when the destination is down.
6. E2E tests on the simulator pass in CI.
7. Generated dashboards load in Grafana 13 and Amazon Managed Grafana 12.4.

## Branching when circumstances change

- If A (MicroVMs) gets stuck in a PoC, advance B (Lambda functions) first. A resumes once the blocking point is resolved.
- If AWS ships official MicroVMs metrics, add an adapter that reads them. Then shift the focus to in-MicroVM correctness (identification and complete delivery) and cost.
- If the official OTel plugin for Durable Functions is fixed, shift D's role toward "replay and cost analysis".
- If Grafana ships the same feature, shift the focus to users of self-hosted LGTM and Amazon Managed Grafana.

## Versioning

- Use SemVer. Compatibility is not guaranteed while on 0.x.
- One version across the entire monorepo.
- Bump the minor version each time a stage is completed (v0.1.0, v0.2.0, etc.).

## Out of scope

- Running Grafana itself on Lambda
- Data source plugins that invoke Lambda
- AI-driven incident response (AI SRE)
- A custom Lambda extension (until v1.0)
- UI and browser-based load tests

## Upstream contributions (by v1.0)

- Submit a PR adding cost metrics to OpenTelemetry's `telemetryapi` receiver.
- Propose MicroVMs attributes to the OpenTelemetry semantic conventions.
- Contribute a serverless example to the Grafana Foundation SDK.
- Publish dashboards on grafana.com.
