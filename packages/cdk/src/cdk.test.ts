import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { KageroDurableStitcher } from "./durable.js";
import { KageroK6Run } from "./k6.js";
import { KageroMicrovmImage, kageroEnvironment } from "./microvm.js";

const FIXTURE_ENTRY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../test/fixture/handler.ts",
);

function makeStack(): { app: App; stack: Stack } {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "kagero-cdk-"));
  const app = new App({ outdir });
  const stack = new Stack(app, "TestStack", {
    env: { region: "us-east-1", account: "123456789012" },
  });
  return { app, stack };
}

const baseKagero = () => ({ backend: "lgtm" as const, baselineGib: 2, baselineVcpu: 2 });

const microvmProps = () => ({
  name: "demo",
  baseImageArn: "arn:aws:lambda:us-east-1::image:base/1",
  baseImageVersion: "1",
  buildRoleArn: "arn:aws:iam::123456789012:role/build",
  codeArtifact: { uri: "s3://bucket/image.zip" },
  cpuConfigurations: [{ architecture: "ARM_64" }],
  description: "demo",
  egressNetworkConnectors: [],
  logging: { disabled: true },
  resources: [{ minimumMemoryInMiB: 2048 }],
});

function imageEnv(t: Template): Record<string, string> {
  const resources = t.findResources("AWS::Lambda::MicrovmImage");
  const env = Object.values(resources)[0]?.Properties?.EnvironmentVariables as {
    Key: string;
    Value: string;
  }[];
  return Object.fromEntries(env.map((e) => [e.Key, e.Value]));
}

describe("kageroEnvironment", () => {
  it("maps config to agent env including defaults", () => {
    const env = kageroEnvironment({
      ...baseKagero(),
      runtimeHookTimeoutSeconds: 30,
      imageHookTimeoutSeconds: 5,
      otlpEndpointLgtm: "http://localhost:4318",
      secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:kagero",
    });
    expect(env.KAGERO_BACKEND).toBe("lgtm");
    expect(env.KAGERO_HOOK_PORT).toBe("2018");
    expect(env.KAGERO_HOOK_TIMEOUT_MS_SUSPEND).toBe("30000");
    expect(env.KAGERO_HOOK_TIMEOUT_MS_VALIDATE).toBe("5000");
    expect(env.KAGERO_MICROVM_SIZE).toBe("2gb");
    expect(env.KAGERO_SECRET_ARN).toContain("secretsmanager");
  });

  it("always emits hook timeouts so env and CFN cannot drift", () => {
    const env = kageroEnvironment(baseKagero());
    expect(env.KAGERO_HOOK_TIMEOUT_MS_RUN).toBe("10000");
    expect(env.KAGERO_HOOK_TIMEOUT_MS_TERMINATE).toBe("10000");
    expect(env.KAGERO_HOOK_TIMEOUT_MS_READY).toBe("10000");
  });

  it("supports the both backend (ADR-002)", () => {
    const env = kageroEnvironment({ ...baseKagero(), backend: "both" });
    expect(env.KAGERO_BACKEND).toBe("both");
  });

  it("rejects secret-looking env keys (ADR-011)", () => {
    for (const key of [
      "GRAFANA_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "GRAFANA_API_KEY",
      "SIGNING_KEY",
      "AUTH_PASSWORD",
    ]) {
      expect(() =>
        kageroEnvironment({ ...baseKagero(), extraEnvironment: { [key]: "x" } }),
      ).toThrow(/ADR-011/);
    }
    // ARN references are not secrets.
    const env = kageroEnvironment({
      ...baseKagero(),
      extraEnvironment: { FOO_SECRET_ARN: "arn:x" },
    });
    expect(env.FOO_SECRET_ARN).toBe("arn:x");
  });

  it("rejects extraEnvironment colliding with managed keys", () => {
    expect(() =>
      kageroEnvironment({
        ...baseKagero(),
        extraEnvironment: { KAGERO_HOOK_PORT: "9999" },
      }),
    ).toThrow(/managed by the construct/);
  });

  it("rejects env_safe violations on image metadata", () => {
    expect(() => kageroEnvironment({ ...baseKagero(), imageVersion: 'v1"$(rm -rf /)' })).toThrow(
      /env_safe/,
    );
  });

  it("serializes collectorArgs as a JSON array", () => {
    const env = kageroEnvironment({
      ...baseKagero(),
      collectorBin: "/opt/bin/otelcol",
      collectorArgs: ["--config", "{config}"],
    });
    expect(env.KAGERO_COLLECTOR_ARGS).toBe('["--config","{config}"]');
  });

  it("rejects control characters in template-interpolated values", () => {
    expect(() =>
      kageroEnvironment({ ...baseKagero(), otlpEndpointLgtm: "http://a\nprocessors:" }),
    ).toThrow(/control character/);
    expect(() =>
      kageroEnvironment({ ...baseKagero(), collectorConfigOut: "/tmp/c.yaml\t" }),
    ).toThrow(/control character/);
  });

  it("rejects any KAGERO_* key in extraEnvironment", () => {
    expect(() =>
      kageroEnvironment({ ...baseKagero(), extraEnvironment: { KAGERO_APP_UID: "0" } }),
    ).toThrow(/managed by the construct/);
  });

  it("emits per-signal CloudWatch endpoint overrides", () => {
    const env = kageroEnvironment({
      ...baseKagero(),
      otlpEndpointCwTraces: "https://vpce-traces.example.com",
      otlpEndpointCwMetrics: "https://vpce-metrics.example.com",
      otlpEndpointCwLogs: "https://vpce-logs.example.com",
    });
    expect(env.KAGERO_ENDPOINT_CW_TRACES).toBe("https://vpce-traces.example.com");
    expect(env.KAGERO_ENDPOINT_CW_METRICS).toBe("https://vpce-metrics.example.com");
    expect(env.KAGERO_ENDPOINT_CW_LOGS).toBe("https://vpce-logs.example.com");
    expect(() =>
      kageroEnvironment({ ...baseKagero(), otlpEndpointCwTraces: "https://a\nb" }),
    ).toThrow(/control character/);
  });
});

describe("KageroMicrovmImage", () => {
  it("synthesizes hooks ENABLED with timeouts in both places", () => {
    const { stack } = makeStack();
    new KageroMicrovmImage(stack, "Img", {
      ...microvmProps(),
      kagero: { ...baseKagero(), runtimeHookTimeoutSeconds: 30 },
    });
    const t = Template.fromStack(stack);
    t.hasResourceProperties("AWS::Lambda::MicrovmImage", {
      Name: "demo",
      Hooks: {
        Port: 2018,
        MicrovmHooks: {
          Run: "ENABLED",
          Resume: "ENABLED",
          Suspend: "ENABLED",
          Terminate: "ENABLED",
          RunTimeoutInSeconds: 30,
          ResumeTimeoutInSeconds: 30,
          SuspendTimeoutInSeconds: 30,
          TerminateTimeoutInSeconds: 30,
        },
        MicrovmImageHooks: {
          Ready: "ENABLED",
          Validate: "ENABLED",
          ReadyTimeoutInSeconds: 10,
          ValidateTimeoutInSeconds: 10,
        },
      },
    });
    const byKey = imageEnv(t);
    expect(byKey.KAGERO_BACKEND).toBe("lgtm");
    expect(byKey.KAGERO_HOOK_TIMEOUT_MS_RUN).toBe("30000");
    expect(byKey.KAGERO_HOOK_TIMEOUT_MS_READY).toBe("10000");
    expect(byKey.KAGERO_MICROVM_IMAGE_NAME).toBe("demo");
  });

  it("emits DISABLED hooks when hooksDisabled", () => {
    const { stack } = makeStack();
    new KageroMicrovmImage(stack, "Img", {
      ...microvmProps(),
      kagero: { ...baseKagero(), hooksDisabled: true },
    });
    const resources = Template.fromStack(stack).findResources("AWS::Lambda::MicrovmImage");
    const hooks = Object.values(resources)[0]?.Properties?.Hooks;
    expect(hooks.MicrovmHooks.Run).toBe("DISABLED");
    expect(hooks.MicrovmImageHooks.Ready).toBe("DISABLED");
  });

  it("rejects out-of-range values at synth time", () => {
    const { stack } = makeStack();
    for (const [field, value] of [
      ["runtimeHookTimeoutSeconds", 61],
      ["runtimeHookTimeoutSeconds", 0],
      ["imageHookTimeoutSeconds", 301],
      ["baselineGib", 0],
      ["hookPort", 70000],
    ] as const) {
      expect(
        () =>
          new KageroMicrovmImage(stack, `Img${field}${value}`, {
            ...microvmProps(),
            kagero: { ...baseKagero(), [field]: value },
          }),
      ).toThrow();
    }
  });

  it("rejects secrets passed through the construct", () => {
    const { stack } = makeStack();
    expect(
      () =>
        new KageroMicrovmImage(stack, "Img", {
          ...microvmProps(),
          kagero: {
            ...baseKagero(),
            extraEnvironment: { GRAFANA_TOKEN: "glsa_xxx" },
          },
        }),
    ).toThrow(/ADR-011/);
  });

  it("rejects more than 50 env vars", () => {
    const { stack } = makeStack();
    const extraEnvironment = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`EXTRA_${i}`, "v"]),
    );
    expect(
      () =>
        new KageroMicrovmImage(stack, "Img", {
          ...microvmProps(),
          kagero: { ...baseKagero(), extraEnvironment },
        }),
    ).toThrow(/at most 50/);
  });
});

describe("KageroDurableStitcher", () => {
  it("creates fn + status rule + DLQ + history permission", () => {
    const { stack } = makeStack();
    new KageroDurableStitcher(stack, "Stitch", {
      entry: FIXTURE_ENTRY,
      otlpEndpoint: "https://example.com/otlp",
      backend: "lgtm",
      otlpHeaderSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:h-AbC123",
    });
    const t = Template.fromStack(stack);

    t.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
      Environment: {
        Variables: Match.objectLike({
          KAGERO_OTLP_ENDPOINT: "https://example.com/otlp",
          KAGERO_BACKEND: "lgtm",
          KAGERO_OTLP_HEADER_SECRET_ARN: Match.stringLikeRegexp("secretsmanager"),
        }),
      },
    });
    t.hasResourceProperties("AWS::Events::Rule", {
      EventPattern: {
        source: ["aws.lambda"],
        "detail-type": ["Durable Execution Status Change"],
        detail: { status: ["SUCCEEDED", "FAILED", "TIMED_OUT", "STOPPED"] },
      },
    });
    t.resourceCountIs("AWS::SQS::Queue", 1);
    // events:PutEvents → Lambda invoke permission exists.
    const perms = t.findResources("AWS::Lambda::Permission");
    expect(Object.keys(perms).length).toBeGreaterThan(0);
    // DLQ wired on the rule target.
    const rules = t.findResources("AWS::Events::Rule");
    const ruleTargets = Object.values(rules)[0]?.Properties?.Targets as {
      DeadLetterConfig: unknown;
    }[];
    expect(ruleTargets[0]?.DeadLetterConfig).toBeDefined();

    const policies = t.findResources("AWS::IAM::Policy");
    const stmts = Object.values(policies).flatMap(
      (p) => p.Properties.PolicyDocument.Statement as { Action: string[]; Resource: unknown }[],
    );
    const history = stmts.find((s) => s.Action.includes("lambda:GetDurableExecutionHistory"));
    expect(history).toBeDefined();
    expect(JSON.stringify(history?.Resource)).toContain("function:*");
    // secretsmanager read granted for the header secret.
    const secretRead = stmts.find((s) => s.Action.includes("secretsmanager:GetSecretValue"));
    expect(secretRead).toBeDefined();
  });

  it("backend 'both' emits the two per-backend endpoint env vars", () => {
    const { stack } = makeStack();
    new KageroDurableStitcher(stack, "Stitch", {
      entry: FIXTURE_ENTRY,
      backend: "both",
      otlpEndpointLgtm: "https://lgtm.example.com/otlp",
      otlpEndpointCloudwatch: "https://cw.example.com/otlp",
    });
    const t = Template.fromStack(stack);
    t.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          KAGERO_BACKEND: "both",
          KAGERO_OTLP_ENDPOINT_LGTM: "https://lgtm.example.com/otlp",
          KAGERO_OTLP_ENDPOINT_CLOUDWATCH: "https://cw.example.com/otlp",
        }),
      },
    });
  });

  it("rejects missing endpoints for both modes", () => {
    const { stack } = makeStack();
    expect(
      () =>
        new KageroDurableStitcher(stack, "Stitch1", {
          entry: FIXTURE_ENTRY,
          backend: "lgtm",
        }),
    ).toThrow(/otlpEndpoint/);
    expect(
      () =>
        new KageroDurableStitcher(stack, "Stitch2", {
          entry: FIXTURE_ENTRY,
          backend: "both",
          otlpEndpointCloudwatch: "https://cw.example.com/otlp",
        }),
    ).toThrow(/requires otlpEndpointLgtm/);
    // 'both' may omit the CloudWatch endpoint — the function's region
    // derives the AWS defaults at runtime.
    new KageroDurableStitcher(stack, "Stitch3", {
      entry: FIXTURE_ENTRY,
      backend: "both",
      otlpEndpointLgtm: "https://lgtm.example.com/otlp",
    });
  });

  it("cloudwatch backend may omit otlpEndpoint — region derives the AWS defaults", () => {
    const { stack } = makeStack();
    new KageroDurableStitcher(stack, "Stitch", {
      entry: FIXTURE_ENTRY,
      backend: "cloudwatch",
      otlpEndpointCloudwatchLogs: "https://vpce-logs.example.com",
      // The CW-specific shared endpoint must reach env under the single
      // cloudwatch backend too — it is not a 'both'-only prop.
      otlpEndpointCloudwatch: "https://vpce-cw.example.com",
      // Per-signal SigV4 service overrides must reach env too — otherwise
      // the runtime's KAGERO_OTLP_SIGV4_SERVICE_* reads would be dead config.
      sigv4ServiceTraces: "xray",
      sigv4ServiceMetrics: "monitoring",
    });
    const t = Template.fromStack(stack);
    t.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          KAGERO_BACKEND: "cloudwatch",
          KAGERO_OTLP_ENDPOINT_CLOUDWATCH: "https://vpce-cw.example.com",
          KAGERO_OTLP_ENDPOINT_CLOUDWATCH_LOGS: "https://vpce-logs.example.com",
          KAGERO_OTLP_SIGV4_SERVICE_TRACES: "xray",
          KAGERO_OTLP_SIGV4_SERVICE_METRICS: "monitoring",
        }),
      },
    });
  });
});

describe("default entries", () => {
  it("resolves and bundles the real durable-stitcher source", { timeout: 60000 }, () => {
    const { stack } = makeStack();
    new KageroDurableStitcher(stack, "Stitch", {
      otlpEndpoint: "https://example.com/otlp",
      backend: "lgtm",
    });
    const t = Template.fromStack(stack);
    t.resourceCountIs("AWS::Lambda::Function", 1);
  });

  it("resolves and bundles the real k6-runner source", { timeout: 60000 }, () => {
    const { stack } = makeStack();
    new KageroK6Run(stack, "Run", { environment: {} });
    const t = Template.fromStack(stack);
    t.resourceCountIs("AWS::StepFunctions::StateMachine", 1);
  });
});

describe("KageroK6Run", () => {
  it("creates a Distributed Map merging shardInput into a ShardEvent", () => {
    const { stack } = makeStack();
    new KageroK6Run(stack, "Run", {
      entry: FIXTURE_ENTRY,
      environment: { KAGERO_BACKEND: "lgtm" },
      maxConcurrency: 4,
      grafanaTokenSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:g-AbC",
    });
    const t = Template.fromStack(stack);

    t.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
      Environment: {
        Variables: Match.objectLike({
          KAGERO_BACKEND: "lgtm",
          KAGERO_GRAFANA_TOKEN_SECRET_ARN: Match.stringLikeRegexp("secretsmanager"),
        }),
      },
    });
    t.resourceCountIs("AWS::StepFunctions::StateMachine", 1);

    const sms = t.findResources("AWS::StepFunctions::StateMachine");
    const def = JSON.stringify(Object.values(sms)[0]?.Properties);
    // The ASL definition is JSON-escaped inside Fn::Join.
    expect(def).toContain('\\"Type\\":\\"Map\\"');
    expect(def).toContain('\\"DISTRIBUTED\\"');
    expect(def).toContain('\\"MaxConcurrency\\":4');
    expect(def).toContain('\\"ItemsPath\\":\\"$.shards\\"');
    // itemSelector merges shardInput + item → a literal ShardEvent.
    expect(def).toContain("States.JsonMerge($.shardInput, $$.Map.Item.Value, false)");
    expect(def).toContain('\\"Payload.$\\":\\"$.payload\\"');
    expect(def).toContain("lambda:invoke");

    // secretsmanager read granted for the grafana token.
    const policies = t.findResources("AWS::IAM::Policy");
    const stmts = Object.values(policies).flatMap(
      (p) => p.Properties.PolicyDocument.Statement as { Action: string[] }[],
    );
    expect(stmts.some((s) => s.Action.includes("secretsmanager:GetSecretValue"))).toBe(true);
  });

  it("rejects plaintext secret env and bad tolerance", () => {
    const { stack } = makeStack();
    expect(
      () =>
        new KageroK6Run(stack, "Run1", {
          entry: FIXTURE_ENTRY,
          environment: { KAGERO_GRAFANA_TOKEN: "glsa_x" },
        }),
    ).toThrow(/SecretArn/);
    expect(
      () =>
        new KageroK6Run(stack, "Run2", {
          entry: FIXTURE_ENTRY,
          toleratedFailurePercentage: 101,
        }),
    ).toThrow(/\[0,100\]/);
  });
});
