/**
 * KageroDurableStitcher — the stitcher Lambda + its EventBridge rule
 * (functions-durable-k6.md §2). The rule matches the verified event
 * shape: source "aws.lambda", detail-type "Durable Execution Status
 * Change". A DLQ catches notifications that fail even after the
 * EventBridge retries.
 *
 * Scope: the rule matches durable executions of every function in the
 * account and region, so the role may read the history of all of them
 * (lambda:GetDurableExecutionHistory on `function:*`). The history is
 * fetched with IncludeExecutionData=false — step names, status and
 * timing, never payloads. There is no per-function filter today.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import {
  Duration,
  aws_events as events,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  Stack,
  aws_sqs as sqs,
  aws_events_targets as targets,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { checkBaseUrl } from "./base-url.js";
import { grantSecretRead } from "./secrets.js";

const require_ = createRequire(import.meta.url);

export interface KageroDurableStitcherProps {
  /** Entry file — defaults to the durable-stitcher package source. */
  entry?: string;
  /**
   * OTLP endpoint the assembled traces/metrics go to (single-backend
   * deployments). Required for `lgtm`; for `cloudwatch` it is the shared
   * endpoint override — unset means region-derived AWS defaults.
   * Ignored when `backend` is "both" (use the per-backend props).
   * Every endpoint prop is a base URL: the stitcher appends /v1/traces
   * and /v1/metrics, so it may carry a prefix path but no query,
   * fragment or userinfo (`OtlpTarget.endpoint` in
   * packages/durable-stitcher). Any other shape fails synth; an
   * unresolved CDK token is checked by the handler at init instead.
   */
  otlpEndpoint?: string;
  /**
   * `both` fans out to KAGERO_OTLP_ENDPOINT_LGTM +
   * KAGERO_OTLP_ENDPOINT_CLOUDWATCH — the LGTM endpoint is required;
   * the CloudWatch side may be omitted to use region-derived AWS
   * defaults (see packages/durable-stitcher handlerFromEnv).
   * `cloudwatch` and `both` grant the role xray:PutTraceSegments,
   * xray:PutSpans and cloudwatch:PutMetricData; the X-Ray OTLP
   * endpoint also needs Transaction Search enabled in the account.
   */
  backend: "lgtm" | "cloudwatch" | "both";
  /** LGTM endpoint — required when backend is "both". */
  otlpEndpointLgtm?: string;
  /**
   * Shared CloudWatch endpoint — honored for backends "cloudwatch" and
   * "both"; optional in both cases since the region derives AWS
   * defaults. Under backend "cloudwatch", `otlpEndpoint` is the shared
   * value first (KAGERO_OTLP_ENDPOINT), this prop the
   * KAGERO_OTLP_ENDPOINT_CLOUDWATCH override — matching the runtime's
   * resolution order.
   */
  otlpEndpointCloudwatch?: string;
  /**
   * CloudWatch per-signal OTLP endpoint overrides (VPC endpoints etc).
   * AWS OTLP endpoints differ per signal — xray.<region> for traces,
   * monitoring.<region> for metrics — and the handler derives the
   * defaults from the function's region when these are unset.
   */
  otlpEndpointCloudwatchTraces?: string;
  otlpEndpointCloudwatchMetrics?: string;
  otlpEndpointCloudwatchLogs?: string;
  /** SigV4 service override applied to every cloudwatch signal. */
  sigv4Service?: string;
  /**
   * Per-signal SigV4 service overrides (e.g. a non-default signing
   * service on a VPC endpoint). Win over `sigv4Service` per signal;
   * the handler reads KAGERO_OTLP_SIGV4_SERVICE_TRACES/_METRICS.
   */
  sigv4ServiceTraces?: string;
  sigv4ServiceMetrics?: string;
  /**
   * Secrets Manager ARN holding the "Name: value" write-scoped OTLP
   * header for the LGTM target. The CloudWatch target never receives it
   * (SigV4 only). The ARN lands in env (ADR-011 allows references); the
   * handler resolves it via Secrets Manager at cold start.
   */
  otlpHeaderSecretArn?: string;
  deadLetterQueue?: sqs.IQueue;
  memorySize?: number;
  timeout?: Duration;
}

export class KageroDurableStitcher extends Construct {
  readonly fn: nodejs.NodejsFunction;
  readonly rule: events.Rule;
  readonly deadLetterQueue: sqs.IQueue;

  constructor(scope: Construct, id: string, props: KageroDurableStitcherProps) {
    super(scope, id);
    const stack = Stack.of(this);

    if (props.backend === "both") {
      if (!props.otlpEndpointLgtm) {
        throw new Error("KageroDurableStitcher backend 'both' requires otlpEndpointLgtm");
      }
    } else if (props.backend === "lgtm" && !props.otlpEndpoint) {
      // cloudwatch may derive every signal endpoint from the function's
      // region (AWS_REGION is always set on Lambda); lgtm cannot.
      throw new Error("KageroDurableStitcher requires otlpEndpoint for the lgtm backend");
    }
    // The handler refuses these at init; fail synth instead.
    for (const [label, v] of [
      ["otlpEndpoint", props.otlpEndpoint],
      ["otlpEndpointLgtm", props.otlpEndpointLgtm],
      ["otlpEndpointCloudwatch", props.otlpEndpointCloudwatch],
      ["otlpEndpointCloudwatchTraces", props.otlpEndpointCloudwatchTraces],
      ["otlpEndpointCloudwatchMetrics", props.otlpEndpointCloudwatchMetrics],
      ["otlpEndpointCloudwatchLogs", props.otlpEndpointCloudwatchLogs],
    ] as const) {
      if (v) checkBaseUrl(`KageroDurableStitcher ${label}`, v);
    }

    this.deadLetterQueue =
      props.deadLetterQueue ??
      new sqs.Queue(this, "Dlq", { retentionPeriod: Duration.days(14), enforceSSL: true });

    this.fn = new nodejs.NodejsFunction(this, "Fn", {
      entry:
        props.entry ??
        path.join(
          path.dirname(require_.resolve("@kagero/durable-stitcher/package.json")),
          "src/index.ts",
        ),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      memorySize: props.memorySize ?? 256,
      timeout: props.timeout ?? Duration.seconds(60),
      // The durable history and secrets APIs must come from the pinned
      // SDK — the runtime-bundled SDK's version is not guaranteed.
      bundling: { bundleAwsSDK: true },
      environment: {
        KAGERO_BACKEND: props.backend,
        ...(props.backend === "both"
          ? {
              KAGERO_OTLP_ENDPOINT_LGTM: props.otlpEndpointLgtm as string,
              ...(props.otlpEndpointCloudwatch
                ? { KAGERO_OTLP_ENDPOINT_CLOUDWATCH: props.otlpEndpointCloudwatch }
                : {}),
            }
          : {
              ...(props.otlpEndpoint ? { KAGERO_OTLP_ENDPOINT: props.otlpEndpoint } : {}),
              // backend "cloudwatch": the CW-specific shared endpoint
              // wins over the generic one in the runtime's resolution.
              ...(props.backend === "cloudwatch" && props.otlpEndpointCloudwatch
                ? { KAGERO_OTLP_ENDPOINT_CLOUDWATCH: props.otlpEndpointCloudwatch }
                : {}),
            }),
        ...(props.otlpEndpointCloudwatchTraces
          ? { KAGERO_OTLP_ENDPOINT_CLOUDWATCH_TRACES: props.otlpEndpointCloudwatchTraces }
          : {}),
        ...(props.otlpEndpointCloudwatchMetrics
          ? { KAGERO_OTLP_ENDPOINT_CLOUDWATCH_METRICS: props.otlpEndpointCloudwatchMetrics }
          : {}),
        ...(props.otlpEndpointCloudwatchLogs
          ? { KAGERO_OTLP_ENDPOINT_CLOUDWATCH_LOGS: props.otlpEndpointCloudwatchLogs }
          : {}),
        ...(props.sigv4Service ? { KAGERO_OTLP_SIGV4_SERVICE: props.sigv4Service } : {}),
        ...(props.sigv4ServiceTraces
          ? { KAGERO_OTLP_SIGV4_SERVICE_TRACES: props.sigv4ServiceTraces }
          : {}),
        ...(props.sigv4ServiceMetrics
          ? { KAGERO_OTLP_SIGV4_SERVICE_METRICS: props.sigv4ServiceMetrics }
          : {}),
        ...(props.otlpHeaderSecretArn
          ? { KAGERO_OTLP_HEADER_SECRET_ARN: props.otlpHeaderSecretArn }
          : {}),
      },
    });

    if (props.otlpHeaderSecretArn) {
      grantSecretRead(this, "OtlpHeaderSecret", props.otlpHeaderSecretArn, this.fn);
    }

    // GetDurableExecutionHistory authorizes against the durable
    // execution ARN (…:function:NAME:QUALIFIER/durable-execution/…);
    // the trailing wildcard covers it (durable-security docs).
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:GetDurableExecutionHistory"],
        resources: [
          `arn:${stack.partition}:lambda:${stack.region}:${stack.account}:function:*`,
          `arn:${stack.partition}:lambda:${stack.region}:${stack.account}:function:*:*`,
        ],
      }),
    );

    // The handler SigV4-signs its CloudWatch posts with this role:
    // traces to xray.<region>, metrics to monitoring.<region>. AWS's
    // OTLP setup guides grant PutTraceSegments (CloudWatchAgentServerPolicy)
    // while the service authorization reference lists PutSpans for
    // OTLP spans — grant both. X-Ray's Put actions take no resource ARN.
    if (props.backend !== "lgtm") {
      this.fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["xray:PutTraceSegments", "xray:PutSpans", "cloudwatch:PutMetricData"],
          resources: ["*"],
        }),
      );
    }

    this.rule = new events.Rule(this, "StatusRule", {
      eventPattern: {
        source: ["aws.lambda"],
        detailType: ["Durable Execution Status Change"],
        // The handler skips RUNNING — filter at the rule so it never
        // costs an invocation (notifications also fire on start).
        detail: { status: ["SUCCEEDED", "FAILED", "TIMED_OUT", "STOPPED"] },
      },
    });
    this.rule.addTarget(
      new targets.LambdaFunction(this.fn, {
        deadLetterQueue: this.deadLetterQueue,
        retryAttempts: 2,
      }),
    );
  }
}
