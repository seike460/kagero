# Collector configurations

Templates the kagero agent renders at `/run` (and validates at `/ready`).
Shared receive/process layout per backend — only exporters and auth differ
(ADR-002, architecture.md §5). Synchronous export per ADR-006: no batch
processor, no sending queue — when the app's flush returns, the backend
has already answered.

## Layout

| Path | Collector | Backend | Format |
|---|---|---|---|
| `lgtm/collector.yaml.tmpl` | contrib OTel collector | LGTM (Mimir/Loki/Tempo) | OTel YAML |
| `cloudwatch/collector.yaml.tmpl` | contrib OTel collector | Amazon CloudWatch | OTel YAML |
| `alloy/lgtm.alloy.tmpl` | Grafana Alloy (default) | LGTM | river |
| `rotel/lgtm.env.tmpl` | Rotel | LGTM | env |
| `rotel/cloudwatch.env.tmpl` | Rotel | CloudWatch | env |

Alloy is the default (ADR-007) and the shipped Alloy template is
**LGTM-only** — there is no Alloy/CloudWatch template; for CloudWatch use
the contrib collector YAML or the Rotel env template. Rotel is the
lightweight comparison target. PoC-04 decides memory/startup/reload
trade-offs; PoC-05 verifies backend parity.

The LGTM templates assume **one endpoint for all three signals** — a
unified OTLP gateway such as `grafana/otel-lgtm` or the Grafana Cloud
OTLP endpoint. A split Loki/Tempo/Mimir deployment needs three separate
exporters; that variant is not shipped yet.

`KAGERO_BACKEND=both` is a marker the shipped templates do **not** act on
— every template here exports to a single backend. For dual export,
mount a custom `KAGERO_COLLECTOR_CONFIG_TEMPLATE` with both exporters
(the agent warns when `both` is set).

## Placeholder contract

Rendered by `crates/kagero-agent::collector::render_template`. Leftover
`{{KAGERO_*` text after substitution fails the render (never shipped).

| Placeholder | Value |
|---|---|
| `{{KAGERO_MICROVM_ID}}` | `microvmId` from the `/run` body |
| `{{KAGERO_TENANT_ID}}` / `{{KAGERO_SESSION_ID}}` | extracted via JSON Pointer (optional) |
| `{{KAGERO_IMAGE_NAME}}` / `{{KAGERO_IMAGE_VERSION}}` / `{{KAGERO_SIZE}}` / `{{KAGERO_REGION}}` | image env config |
| `{{KAGERO_OTLP_PORT}}` | loopback OTLP/HTTP receiver port |
| `{{KAGERO_ENDPOINT_LGTM}}` / `{{KAGERO_ENDPOINT_CLOUDWATCH}}` | backend OTLP endpoints |
| `{{KAGERO_ENDPOINT_CW_METRICS}}` / `{{KAGERO_ENDPOINT_CW_LOGS}}` / `{{KAGERO_ENDPOINT_CW_TRACES}}` | per-signal CloudWatch OTLP endpoints — AWS OTLP uses a different host per signal (`monitoring.`/`logs.`/`xray.`) and a different SigV4 service (`monitoring`/`logs`/`xray`). Resolution: per-signal env (`KAGERO_ENDPOINT_CW_*` in the MicroVM agent, `KAGERO_OTLP_ENDPOINT_CLOUDWATCH_*` in the durable-stitcher Lambda) → shared endpoint (`KAGERO_OTLP_ENDPOINT_CLOUDWATCH`, falling back to `KAGERO_OTLP_ENDPOINT` whenever the stitcher has a CloudWatch target) → region-derived AWS default |
| `{{KAGERO_BACKEND}}` | `lgtm` / `cloudwatch` / `both` |
| `{{KAGERO_SECRET}}` | whole SecretString — same safety check as keyed values, so a JSON document fails closed (it contains quotes); prefer `{{KAGERO_SECRET:key}}` |
| `{{KAGERO_SECRET:key}}` | one key of the JSON SecretString |
| `{{KAGERO_RESOURCE_ATTRS}}` | OTel `resource` actions for logs/traces (full identity incl. ids) |
| `{{KAGERO_METRIC_ATTRS}}` | same list, registry-allowed subset only (ADR-008) |

Endpoint values (`KAGERO_OTLP_ENDPOINT*`, `KAGERO_ENDPOINT_CW_*`) are
substituted verbatim into double-quoted YAML/river strings and into env
files that a shell sources. The agent therefore refuses to start when
one is not printable ASCII or contains `"`, `\`, `$` or a backtick —
percent-encode such characters in the URL.

Each endpoint value, and `KAGERO_IMDS_ENDPOINT`, must also be an
absolute `http://` or `https://` URL with a host
(`https://otlp.example.com`, not `otlp.example.com:4318`). Otherwise the
agent refuses to start with an error that names the variable. An empty
value counts as unset. The startup log (`kagero starting`) shows only
the scheme and the host (with port) of each URL: userinfo becomes
`REDACTED@`, and a path, query or fragment becomes `/REDACTED`, since
any of them can carry a token.

### Secret expansion safety

`{{KAGERO_SECRET:...}}` and `{{KAGERO_SECRET}}` are expanded **only on the
pristine template** — before untrusted scalar values (tenant/session ids
from `runHookPayload`) are substituted. An id containing a smuggled
`{{KAGERO_SECRET:...}}` mark therefore stays literal and trips the
fail-closed leftover check; secret values themselves are never
re-scanned.

## Secret shape

`KAGERO_SECRET_ARN` points at a Secrets Manager JSON secret. Templates
expect keys `username` and `password` (LGTM basic auth) or `basic_b64`
(Rotel `Authorization` header). Because secrets are substituted verbatim
into YAML, river and env-file contexts, **secret values must be printable
ASCII without `"`, `\`, `$`, backticks or newlines** — quote/escape
handling is not applied per format, and rendered env files may be sourced
by a shell. A secret *value* containing the literal `{{KAGERO_` mark
trips the leftover-placeholder check and fails the render — pick
secrets without that substring. CloudWatch needs no secret — the
collector's `sigv4auth` extension signs with the execution role
(ADR-011). The permissions that role needs are listed under CloudWatch
prerequisites.

## CloudWatch prerequisites

The CloudWatch templates (`cloudwatch/collector.yaml.tmpl` and
`rotel/cloudwatch.env.tmpl`) rely on AWS resources that kagero neither
creates nor grants. Set them up before the first `/run`; without them,
AWS rejects the exports.

- **Log group and log stream.** The CloudWatch Logs OTLP endpoint writes
  only to a log group and log stream that already exist. Create the log
  group `/kagero/<image-name>` (`KAGERO_MICROVM_IMAGE_NAME`) and the log
  stream `otlp` in it. Every MicroVM of the image writes to that one
  stream. The OTel Collector template tells them apart by resource
  attributes; the Rotel template does not (see Unverified below).
- **Execution role.** The collector signs with the MicroVM's execution
  role (`--execution-role-arn` of `run-microvm`). With the OTel Collector
  template, the role needs:
  - `logs:PutLogEvents` on
    `arn:aws:logs:<region>:<account>:log-group:/kagero/<image-name>:*`
  - `cloudwatch:PutMetricData` on `*`
  - `xray:PutTraceSegments` and `xray:PutSpans` on `*`. The X-Ray OTLP
    endpoint also needs Transaction Search enabled in the account.

  The Rotel template sends metrics and traces with `awsemf` and
  `awsxray`, whose permissions are not confirmed yet (PoC-04/05). AWS's
  collector setup guide attaches `CloudWatchAgentServerPolicy`, which
  covers them. PoC-01 and PoC-05 confirm the minimal set.

## Identity filtering (ADR-008)

The OTel Collector and Alloy templates stamp ids at **resource** level
(`resource` processor / `otelcol.processor.transform` with
`context = "resource"`), not record level — resource attributes are
what Prometheus-style ingestion turns into labels. Their metrics
pipeline additionally deletes every id-shaped key the app may have
claimed on its own resource (`service.instance.id`, `faas.instance`,
`kagero.tenant.id`, `kagero.session.id`, …) at resource, datapoint AND
scope level — scope attributes surface as `otel_scope_*` labels on
Prometheus-compatible ingestion. Logs and traces get the full identity
via `upsert`, overwriting app self-claims. The Rotel templates do none
of this (see the Rotel caveats under Unverified).

## Spawn contract

`KAGERO_COLLECTOR_ARGS` (JSON array of strings) is the argv after
`KAGERO_COLLECTOR_BIN`; `{config}` inside an arg is replaced by
`KAGERO_COLLECTOR_CONFIG_OUT`. When a non-empty list has no `{config}`
token the config path is appended last; an empty list means no argv at
all.

| Collector | `KAGERO_COLLECTOR_BIN` | `KAGERO_COLLECTOR_ARGS` |
|---|---|---|
| Alloy | `alloy` | `["run","--storage.path=/run/kagero/collector-data","{config}"]` (default) |
| contrib otelcol | `otelcol-contrib` | `["--config","{config}"]` |
| Rotel | `sh` | `["-c","set -a; . \"$0\"; exec rotel","{config}"]` — sources the rendered env file, then execs rotel |

## Agent env vars consumed here

`KAGERO_COLLECTOR_BIN`, `KAGERO_COLLECTOR_ARGS`,
`KAGERO_COLLECTOR_CONFIG_TEMPLATE`, `KAGERO_COLLECTOR_CONFIG_OUT`,
`KAGERO_COLLECTOR_START` (`build`/`run`), `KAGERO_COLLECTOR_RELOAD_URL`,
`KAGERO_BACKEND`, `KAGERO_SECRET_ARN`.

`KAGERO_COLLECTOR_START=build` starts the collector before the snapshot.
When `KAGERO_SECRET_ARN` is also set, the first start waits for `/run`,
because the rendered config needs the secret that `/run` fetches.

## Unverified (PoC)

- Alloy vs Rotel memory/startup/reload comparison — PoC-04.
- CloudWatch OTLP SigV4 service name, log-group headers — PoC-05.
  The minimal execution-role permissions — PoC-01 / PoC-05.
- Rotel caveats: batch internals prevent full ADR-006 synchronicity, and
  `ROTEL_OTEL_RESOURCE_ATTRIBUTES` applies to ALL signals with no
  per-signal scoping. The shipped Rotel templates therefore stamp only
  metric-safe attributes — **instance/tenant/session ids are not
  attached at all on the Rotel path**, so per-VM drilldown of
  logs/traces is unavailable there. They also **strip nothing**: ids
  that the app sets on its own telemetry (`service.instance.id`, for
  example) reach the metric labels, against ADR-008. Full identity and
  the strip require the OTel Collector or Alloy templates. Re-verify
  Rotel's per-signal support in PoC-04 before extending this.
