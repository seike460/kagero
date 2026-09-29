/**
 * KageroK6Run — a Distributed Map of worker Lambdas each running one
 * k6 execution segment (functions-durable-k6.md §3, PoC-10).
 *
 * Execution input shape:
 * ```json
 * {
 *   "shardInput": {
 *     "runId": "r-1", "shardCount": 4, "scriptPath": "/opt/k6/test.js",
 *     "startAtMs": 1750000000000, "backend": "lgtm",
 *     "extraTags": { "suite": "checkout" }
 *   },
 *   "shards": [
 *     { "shardIndex": 0, "annotate": true },
 *     { "shardIndex": 1 }, { "shardIndex": 2 }, { "shardIndex": 3 }
 *   ]
 * }
 * ```
 *
 * `shardInput` holds everything shards share; each item overrides with
 * its own `shardIndex` (and optionally extraArgs/extraTags/k6Bin). The
 * map merges them with States.JsonMerge and hands the worker a literal
 * ShardEvent — no field-name translation to drift.
 *
 * Every shard waits for `startAtMs` (epoch ms) inside its invocation,
 * so a start more than 10 minutes ahead is refused — the wait and the
 * k6 run share the Lambda timeout.
 *
 * The construct ships neither k6 nor the script. The worker spawns
 * `k6` from PATH (or the ShardEvent's absolute `k6Bin`), so add a layer
 * with `bin/k6` built for the worker's architecture —
 * `run.worker.addLayers(...)` puts it at /opt/bin/k6, which Lambda keeps
 * on PATH — and ship the script the same way (a layer's `k6/test.js`
 * is /opt/k6/test.js). Without k6, every shard waits until `startAtMs`
 * and then fails. `scriptPath` must be a file inside the worker — under
 * the function code (LAMBDA_TASK_ROOT, /var/task; a relative path
 * resolves there) or a layer (/opt). A URL, `-`, or a path or symlink
 * that leads elsewhere (/tmp, ../) is refused, so the execution input
 * cannot point k6 at a remote script or a file written at run time.
 *
 * k6 is AGPL-3.0: kagero only invokes it. A layer that redistributes
 * the binary keeps it unmodified and states the license and where to
 * get the source (functions-durable-k6.md §3-4).
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import {
  Duration,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_stepfunctions as sfn,
  aws_stepfunctions_tasks as tasks,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { checkBaseUrl } from "./base-url.js";
import { grantSecretRead } from "./secrets.js";

const require_ = createRequire(import.meta.url);

export interface KageroK6RunProps {
  /** Entry file — defaults to the k6-runner package source (src/index.ts). */
  entry?: string;
  /**
   * Non-secret env for the worker (backend endpoints, EMF namespace,
   * metric prefix). Secret-looking keys (TOKEN/PASSWORD/SECRET/...)
   * and any *_SECRET_ARN are rejected — use the *SecretArn props below,
   * which also attach the secretsmanager grant (ADR-011). Note the
   * backend comes from each ShardEvent, not env — KAGERO_BACKEND here
   * is dead config. The keys and their values are listed on
   * `outputFromEnv` in packages/k6-runner: KAGERO_OTLP_ENDPOINT there
   * is host:port with no scheme (k6's own format), not the URL that the
   * agent and KageroDurableStitcher take under the same name.
   */
  environment?: Record<string, string>;
  /** Secrets Manager ARNs resolved by the worker at init. This one
   *  holds a Grafana service-account token with annotations:create. */
  grafanaTokenSecretArn?: string;
  /** Password for the http exporter's basic auth; KAGERO_OTLP_USERNAME
   *  goes in `environment`. */
  otlpPasswordSecretArn?: string;
  /** Exporter headers as "k1=v1,k2=v2" (K6_OTEL_HEADERS) — not the
   *  "Name: value" of KageroDurableStitcher's otlpHeaderSecretArn. */
  otlpHeadersSecretArn?: string;
  /** Grafana base URL for region annotations (not secret), e.g.
   *  "https://grafana.example.com", with an optional prefix path. The
   *  worker appends /api/annotations, so a query, fragment or userinfo
   *  fails synth (the Grafana token goes in grafanaTokenSecretArn); an
   *  unresolved CDK token is checked by the worker at init instead. The
   *  same check applies to KAGERO_GRAFANA_URL in `environment`. */
  grafanaUrl?: string;
  memorySize?: number;
  timeout?: Duration;
  /** Upper bound on simultaneous shards (default 10). */
  maxConcurrency?: number;
  /** Fraction of shard failures the run tolerates (0–100). */
  toleratedFailurePercentage?: number;
  stateMachineProps?: Partial<sfn.StateMachineProps>;
}

/** Same key-side rule as the MicroVM image construct (ADR-011). */
const SECRET_KEY_RE =
  /(SECRET|TOKEN|PASSWORD|PASSPHRASE|CREDENTIAL|ACCESS_KEY|API_KEY|PRIVATE|BEARER|SIGNING|_KEY|HEADERS?)(?!_ARN$)/i;

/**
 * Base names the typed *SecretArn props resolve into — a plaintext
 * value for any of these (or a user-supplied *_SECRET_ARN, which
 * would lack a secretsmanager grant) must go through the props.
 */
const MANAGED_SECRET_BASES = new Set([
  "KAGERO_GRAFANA_TOKEN",
  "KAGERO_OTLP_PASSWORD",
  "KAGERO_OTLP_HEADERS",
  "KAGERO_OTLP_HEADER",
]);

export class KageroK6Run extends Construct {
  readonly worker: nodejs.NodejsFunction;
  readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: KageroK6RunProps) {
    super(scope, id);

    if (
      props.toleratedFailurePercentage !== undefined &&
      (!Number.isInteger(props.toleratedFailurePercentage) ||
        props.toleratedFailurePercentage < 0 ||
        props.toleratedFailurePercentage > 100)
    ) {
      throw new Error(
        `toleratedFailurePercentage must be an integer in [0,100], ` +
          `got ${props.toleratedFailurePercentage}`,
      );
    }
    if (
      props.maxConcurrency !== undefined &&
      (!Number.isInteger(props.maxConcurrency) ||
        props.maxConcurrency < 1 ||
        props.maxConcurrency > 10000)
    ) {
      throw new Error(
        `maxConcurrency must be an integer in [1,10000], got ${props.maxConcurrency}`,
      );
    }

    const environment: Record<string, string> = { ...(props.environment ?? {}) };
    for (const key of Object.keys(environment)) {
      if (SECRET_KEY_RE.test(key) || MANAGED_SECRET_BASES.has(key) || key.endsWith("_SECRET_ARN")) {
        throw new Error(
          `environment key "${key}" carries or resolves a secret — pass a ` +
            "Secrets Manager ARN via the *SecretArn props instead (ADR-011)",
        );
      }
    }
    if (props.grafanaUrl) {
      if (environment.KAGERO_GRAFANA_URL !== undefined) {
        throw new Error(
          "KAGERO_GRAFANA_URL set in both environment and grafanaUrl prop — pick one",
        );
      }
      environment.KAGERO_GRAFANA_URL = props.grafanaUrl;
    }
    // The worker refuses a bad value at init; fail synth instead.
    if (environment.KAGERO_GRAFANA_URL) {
      checkBaseUrl(
        props.grafanaUrl ? "grafanaUrl" : "environment KAGERO_GRAFANA_URL",
        environment.KAGERO_GRAFANA_URL,
      );
    }
    const secretGrants: [string | undefined, string][] = [
      [props.grafanaTokenSecretArn, "KAGERO_GRAFANA_TOKEN_SECRET_ARN"],
      [props.otlpPasswordSecretArn, "KAGERO_OTLP_PASSWORD_SECRET_ARN"],
      [props.otlpHeadersSecretArn, "KAGERO_OTLP_HEADERS_SECRET_ARN"],
    ];
    for (const [arn, envName] of secretGrants) {
      if (arn) environment[envName] = arn;
    }

    this.worker = new nodejs.NodejsFunction(this, "Worker", {
      entry:
        props.entry ??
        path.join(path.dirname(require_.resolve("@kagero/k6-runner/package.json")), "src/index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      memorySize: props.memorySize ?? 1024,
      timeout: props.timeout ?? Duration.minutes(15),
      environment,
      // The secrets-manager SDK must be bundled — the runtime-bundled
      // SDK's presence/version is not guaranteed.
      bundling: { bundleAwsSDK: true },
    });

    for (const [arn, envName] of secretGrants) {
      if (arn) grantSecretRead(this, `Secret${envName}`, arn, this.worker);
    }

    const invoke = new tasks.LambdaInvoke(this, "RunShard", {
      lambdaFunction: this.worker,
      // itemSelector below produces {payload: <merged ShardEvent>}.
      payload: sfn.TaskInput.fromJsonPathAt("$.payload"),
    });

    const map = new sfn.DistributedMap(this, "Shards", {
      itemsPath: "$.shards",
      maxConcurrency: props.maxConcurrency ?? 10,
      toleratedFailurePercentage: props.toleratedFailurePercentage,
      // Shared fields + per-item overrides → a literal ShardEvent.
      itemSelector: {
        "payload.$": "States.JsonMerge($.shardInput, $$.Map.Item.Value, false)",
      },
    });
    map.itemProcessor(invoke);

    this.stateMachine = new sfn.StateMachine(this, "Machine", {
      definitionBody: sfn.DefinitionBody.fromChainable(map),
      ...props.stateMachineProps,
    });
    // LambdaInvoke grants lambda:InvokeFunction on the state machine
    // role automatically when the task is bound to it.
  }
}
