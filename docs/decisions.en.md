# Architecture Decision Records

> English translation of [decisions.md](decisions.md) (Japanese is canonical). Last synced: 2026-09-27.

- Last updated: 2026-09-26
- Status meanings: "accepted" means decided. "proposed" will be decided by PoC results. "rejected" is an option that was not taken.
- New ADRs are appended at the end with the next number. When a decision changes, do not delete the old ADR; mark it as "superseded".

## Format

```markdown
## ADR-NNN: Title

- Status: proposed / accepted / rejected / superseded by ADR-MMM
- Date: YYYY-MM-DD
- Verifying PoC: PoC-NN ("none" if there is none)

### Background
### Decision
### Rationale
### Consequences
```

## List

| No. | Title | Status | Verifying PoC |
|---|---|---|---|
| 001 | Monorepo and language split | accepted | none |
| 002 | Supporting two backends from day one | accepted | PoC-05 |
| 003 | Apache-2.0 and the unofficial notice | accepted | none |
| 004 | Ordered hook relay | proposed | PoC-02 |
| 005 | Quiesce at build, arm on /run | proposed | PoC-03 |
| 006 | Guaranteeing flush with synchronous export | proposed | PoC-04 |
| 007 | Collector selection | proposed | PoC-04 |
| 008 | Identity and cardinality | proposed | PoC-05 |
| 009 | Cost model | proposed | PoC-09 |
| 010 | Dashboard and alert spec | proposed | PoC-05, PoC-06 |
| 011 | Secret delivery | proposed | PoC-01 |
| 012 | Implementation before the M0 gate (record of deviation) | accepted | all PoCs |

## ADR-001: Monorepo and language split

- Status: accepted
- Date: 2026-09-26
- Verifying PoC: none

### Background

kagero has four modules plus shared components. Components that run inside a MicroVM and components that run outside it on AWS have different requirements.

### Decision

- Keep everything in a single repository (a monorepo).
- Only the agent that runs inside the MicroVM is written in Rust.
- The control-plane Lambda functions, CDK constructs, dashboard generation, and the simulator are written in TypeScript (Node.js 24).

### Rationale

- The agent is embedded into every image a user brings. It must keep the memory and snapshot footprint small. Rust fits: it ships as a single binary and can control processes and capabilities directly.
- CDK and the Grafana Foundation SDK have no Rust version.
- The control-plane Lambda functions are invoked rarely, so cold-start differences do not matter. TypeScript, which shares the same toolchain as CDK, is faster to build with.

### Consequences

- The scope of Rust code is limited to the single agent.
- CI maintains two pipelines: Rust and TypeScript.

## ADR-002: Supporting two backends from day one

- Status: accepted
- Date: 2026-09-26
- Verifying PoC: PoC-05 (cataloging the differences)

### Background

Grafana users include people on LGTM (Grafana Cloud or self-hosted Loki, Tempo, and Mimir) and people on CloudWatch. CloudWatch added OTLP ingestion and PromQL support in 2026-06.

### Decision

- Support both LGTM and CloudWatch from day one.
- Also provide a configuration that sends to both at once.

### Rationale

- To reach both users who want everything to stay on AWS and users who want to follow the Grafana mainstream.
- CloudWatch's PromQL support makes it feasible to use the same PromQL spec for both backends.

### Consequences

- Every feature must define its behavior on both backends. Where a backend cannot support something, it is explicitly marked "not supported".
- The amount of work before the first release increases.

## ADR-003: Apache-2.0 and the unofficial notice

- Status: accepted
- Date: 2026-09-26
- Verifying PoC: none

### Decision

- The license is Apache-2.0.
- The README states clearly that the project is not an official product of AWS or Grafana Labs.
- The name does not include the AWS, Grafana, or Lambda trademarks.
- If k6 (AGPL-3.0) is bundled, it is shipped unmodified and attributed according to its license terms.

### Rationale

- It is the same license as OpenTelemetry and Grafana Alloy, making the pieces easy to combine.
- It includes a patent grant, which makes it easy for companies to adopt.

## ADR-004: Ordered hook relay

- Status: proposed
- Date: 2026-09-26
- Verifying PoC: PoC-02

### Background

MicroVMs expose only one port that receives hooks. Both the app and the instrumentation need the hooks.

### Decision (proposed)

- Make `kagero` the container entrypoint (PID 1) and the hook receiver.
- Relay hooks to the app in a fixed order. For `/run` and `/resume`, kagero goes first; for `/suspend` and `/terminate`, the app goes first.
- A runtime failure does not stop the workload. A build-time failure stops the build.

### Rejected alternatives

- Broadcasting to multiple processes at once: ordering and time budgeting cannot be guaranteed.

### Consequences

- Users must change their ENTRYPOINT to kagero.

## ADR-005: Quiesce at build, arm on /run

- Status: proposed
- Date: 2026-09-26
- Verifying PoC: PoC-03

### Background

Snapshots capture RNG state and open connections as well. Every MicroVM launched from the same image starts from identical state.

### Decision (proposed)

- At build time, create no IDs, random seeds, connections, or secrets, and send no telemetry.
- On `/run`, create the instance identity, configure the collector, and let the app initialize the OTel SDK.
- Whether the collector is started at build time or first started on `/run` will be decided by the results of PoC-03 and PoC-04.

### Consequences

- Apps must place OTel SDK initialization on `/run`. Examples will be provided.

## ADR-006: Guaranteeing flush with synchronous export

- Status: proposed
- Date: 2026-09-26
- Verifying PoC: PoC-04

### Decision (proposed)

- Configure the collector for synchronous export. Do not use batching or a send queue.
- On `/suspend` and `/terminate`, proceed in order: the app flushes, then kagero exports. On `/terminate`, the collector is stopped last.

### Rejected alternatives

- Watching the collector's queue metrics and waiting: data inside a batch or in flight is not visible.
- Making kagero itself an OTLP relay: it would mean rebuilding a collector, which is a heavy maintenance burden.

### Consequences

- Waiting for acknowledgment on every export adds latency to the app. PoC-04 measures how much.

## ADR-007: Collector selection

- Status: proposed
- Date: 2026-09-26
- Verifying PoC: PoC-04

### Decision (proposed)

- Grafana Alloy is the default.
- Rotel, written in Rust, is the comparison target.
- Decision criteria: reliability of draining with synchronous export, resident memory, startup and reload time, and support for SigV4 sending to CloudWatch.

### Rationale

- Alloy is Grafana's official collector and works well with LGTM.
- On MicroVMs, resident memory affects cost through snapshot size. The lighter Rotel may have an advantage.

## ADR-008: Identity and cardinality

- Status: proposed
- Date: 2026-09-26
- Verifying PoC: PoC-05

### Decision (proposed)

- Put the MicroVM ID in `service.instance.id`.
- MicroVM, tenant, session, and request IDs are attached only to logs and traces. They are never put on metric labels.
- Tenant and session IDs are attached only when the app provides them explicitly.
- Identity attributes are overwritten on the collector side.
- Attributes not covered by convention get a `kagero.` prefix, and their definitions are consolidated in Weaver YAML.

### Rationale

- CloudWatch PromQL caps at 500 series per query. On Mimir too, series churn is a burden.

## ADR-009: Cost model

- Status: proposed
- Date: 2026-09-26
- Verifying PoC: PoC-09

### Decision (proposed)

- The agent sends only usage facts. Unit prices are applied on the query side.
- The price list is a versioned file, looked up by region, architecture, and effective date.
- Every displayed cost is labeled as an "estimate", and reconciliation results against billing data (CUR) are published.

### Rationale

- The agent cannot run while suspended or after termination.
- Embedding prices in the agent would require rebuilding the image on every price revision.

## ADR-010: Dashboard and alert spec

- Status: proposed
- Date: 2026-09-26
- Verifying PoC: PoC-05, PoC-06

### Decision (proposed)

- Write a single spec with the Grafana Foundation SDK (TypeScript).
- Per-backend adapters render separate outputs for LGTM and for CloudWatch.
- Output is v1 JSON. Generated artifacts are committed, and CI checks the regeneration diff.
- A panel that one backend cannot produce becomes a text panel marked "not supported".

### Rationale

- Maintaining two backends as separate hand-written JSON would double the work.
- Amazon Managed Grafana 12.4 does not support schema v2.

## ADR-011: Secret delivery

- Status: proposed
- Date: 2026-09-26
- Verifying PoC: PoC-01

### Decision (proposed)

- Do not put secrets in image environment variables or in `runHookPayload`.
- Secrets are fetched from Secrets Manager at `/run` using the execution role.
- Credentials for export are write-only, narrowly scoped, and short-lived.
- For sending to CloudWatch, use the execution role's SigV4 and hold no secrets.

### Rationale

- Image environment variables are shared by every MicroVM and are captured in snapshots.
- The app inside a MicroVM may be untrusted code.

### Consequences

- PoC-01 will verify whether the app can reach the execution role's credentials. If it can, the role's permissions are reduced to the minimum.

## ADR-012: Implementation before the M0 gate (record of deviation)

- Status: accepted
- Date: 2026-09-26
- Verifying PoC: all PoCs

### Background

- The roadmap and AGENTS.md stipulated that no implementation code would be written until the M0 PoC gate was passed.
- As of 2026-09-26, no AWS credentials are configured in the development environment, so PoCs on real AWS cannot be run.
- At the requester's direction, implementation equivalent to v0.1–v0.4 proceeded without waiting for the real PoCs.

### Decision

- Implementation proceeds ahead of the PoCs. In place of real AWS, verification uses the following methods.
  - E2E tests in which packages/sim drives the real agent binary over HTTP
  - The full set of CI gates: unit tests, typecheck, lint, and generated-artifact diff checks
  - Inspection of the generated dashboards, alerts, and CDK templates
- ADRs marked "proposed" do not move to "accepted" until the corresponding PoC verifies them on real AWS.
- Specification uncertainties found during implementation (event shapes, API value ranges, product limits) were implemented only after being confirmed in public documentation. Points that could not be confirmed were added to the PoC runbooks as "things to verify".
- Points where the implementation diverges from the design are the first candidates each PoC should verify.

### Rationale

- Even without real AWS, the contracts (hook order, flush, identity, cardinality) can be verified in simulation.
- Having the implementation first lets the PoCs move forward in a "verify something that works" form.

### Consequences

- Properties knowable only on real AWS (actual timeout values, credential reach, real charges, actual snapshot behavior) all remain unverified. The README implementation-status table notes the verification method alongside.
- If a PoC shows reality differing from the design, the implementation is fixed. If the design must change, a new ADR is added.
