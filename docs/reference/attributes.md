# kagero 属性とメトリクス（生成）

正本は `semconv/registry/` の YAML です。このファイルは `pnpm generate` で生成します。
メトリクスのラベル可否は ADR-008 によります（forbidden の属性はメトリクスのラベルに使えません）。

## 属性

| 属性 | 型 | stability | metric label | 説明 |
|---|---|---|---|---|
| `kagero.microvm.image.name` | string | development | allowed | Name of the MicroVM image the instance was launched from. |
| `kagero.microvm.image.version` | string | development | allowed | Version of the MicroVM image. |
| `kagero.microvm.size` | string | development | allowed | Configured baseline size of the MicroVM. |
| `kagero.lifecycle.event` | enum | development | allowed | Lifecycle event that occurred on the MicroVM. /ready and /validate are build hooks and never emit lifecycle events (build time is quiescent), so they are not members.（values: `run`, `suspend`, `resume`, `terminate`, `degraded`） |
| `kagero.tenant.id` | string | development | forbidden | Tenant identifier extracted from runHookPayload when configured. |
| `kagero.session.id` | string | development | forbidden | Session identifier extracted from runHookPayload when configured. |
| `kagero.suspend.duration_seconds` | double | development | forbidden | Wall-clock seconds the MicroVM spent suspended, observed on resume. |
| `kagero.error` | string | development | forbidden | Failure detail on kagero.lifecycle.degraded records. Error text is unbounded — never a metric label. |
| `kagero.app.result` | enum | development | allowed | Outcome of relaying a hook to the app, on lifecycle event records.（values: `ok`, `unimplemented`, `no_listener`, `failed`） |
| `kagero.app.exited` | boolean | development | allowed | Whether the app process had already exited when the hook ran. |
| `kagero.hook.name` | string | development | allowed | Name of the lifecycle hook being relayed. |
| `kagero.hook.status` | enum | development | allowed | Outcome of a relayed hook.（values: `ok`, `timeout`, `error`, `unimplemented`） |
| `kagero.usage.cause` | enum | development | forbidden | Which hook produced the summary.（values: `suspend`, `terminate`） |
| `kagero.usage.running_seconds` | double | development | forbidden | RUNNING wall-clock seconds since /run. |
| `kagero.usage.burst_vcpu_seconds` | double | development | forbidden | vCPU-seconds above the MicroVM baseline. |
| `kagero.usage.burst_gib_seconds` | double | development | forbidden | GiB-seconds above the MicroVM baseline. |
| `kagero.usage.suspend_seconds` | double | development | forbidden | Total seconds spent suspended. |
| `kagero.usage.suspends` | int | development | forbidden | /suspend count this boot. |
| `kagero.usage.resumes` | int | development | forbidden | /resume count this boot. |
| `kagero.durable.execution.arn` | string | development | forbidden | ARN of the durable execution this span belongs to. |
| `kagero.durable.execution.name` | string | development | forbidden | Human-readable name of the durable execution. |
| `kagero.durable.replay_count` | int | development | forbidden | Number of replays (re-executions) observed in the assembled history. |
| `kagero.durable.step.kind` | enum | development | allowed | Kind of durable step a span represents.（values: `step`, `wait`, `callback`, `retry`, `chained`, `invoke`, `context`） |
| `kagero.durable.step.name` | string | development | forbidden | Name of the durable step (user-defined). |
| `kagero.durable.attempt` | int | development | forbidden | Attempt number for retried steps. |
| `kagero.durable.status` | enum | development | allowed | Terminal or current status of a durable execution or step.（values: `succeeded`, `failed`, `timed_out`, `stopped`, `running`） |
| `kagero.k6.run.id` | string | development | allowed | Identifier of one distributed load-test run. |
| `kagero.k6.shard.id` | string | development | allowed | Shard index (0-based) of a k6 segment within a run. |
| `service.name` | string | stable | allowed | Constant "kagero" — anchors the agent's log streams and metric series (Loki {service_name="kagero"}). Safe on metrics. |
| `service.instance.id` | string | stable | forbidden | MicroVM instance identifier received at /run (microvmId). Logs and traces only. |
| `cloud.provider` | string | stable | allowed | Always "aws". |
| `cloud.region` | string | stable | allowed | AWS region the MicroVM runs in. |
| `faas.instance` | string | development | forbidden | MicroVM instance identifier (faas-facing copy of service.instance.id). |

## メトリクス

| 名前 | instrument | 単位 | 説明 |
|---|---|---|---|
| `kagero.microvm.running_seconds` | counter | s | Seconds the MicroVM spent in RUNNING state, observed by the agent. |
| `kagero.microvm.burst_vcpu_seconds` | counter | {vcpu}s | vCPU-seconds consumed above the configured baseline. |
| `kagero.microvm.burst_memory_gib_seconds` | counter | {gib}s | GiB-seconds of memory consumed above the configured baseline. The `{gib}` annotation keeps the Prometheus OTLP unit suffix at "_seconds" (already the name suffix), so translation inserts nothing. |
| `kagero.microvm.lifecycle_transitions` | counter | {transition} | Number of lifecycle transitions, labelled by kagero.lifecycle.event. |
| `kagero.microvm.suspend_duration_seconds` | histogram | s | Distribution of suspend-to-resume wall-clock durations. |
| `kagero.microvm.hook_results` | counter | {hook} | Runtime-hook relay outcomes, labelled by kagero.hook.name and kagero.hook.status. |
| `kagero.durable.executions` | counter | {execution} | Completed durable executions assembled by the stitcher, labelled by kagero.durable.status. |
| `kagero.durable.execution.duration_seconds` | histogram | s | Wall-clock duration of assembled durable executions. |
| `kagero.durable.replays` | counter | {replay} | Replay (re-execution) events observed across assembled executions. |
