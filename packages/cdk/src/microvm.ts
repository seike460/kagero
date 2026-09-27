/**
 * KageroMicrovmImage — a CfnMicrovmImage with the kagero contract baked
 * in (microvms.md §5, §10):
 *
 * - Hooks.Port + every hook ENABLED — the agent listens on that port.
 * - Hook timeouts are written BOTH to the image's *TimeoutInSeconds
 *   fields AND to KAGERO_HOOK_TIMEOUT_MS_* env — one value, two
 *   places, so they cannot drift (§5-2). Both default to the agent's
 *   own default (10 s) rather than staying unset.
 * - All non-secret agent config lands in EnvironmentVariables.
 * - ADR-011 is enforced at synth time: env keys that look like secrets
 *   are rejected (secrets arrive via Secrets Manager at /run).
 */

import { Annotations, aws_lambda as lambda } from "aws-cdk-lib";
import { Construct } from "constructs";

export const KAGERO_DEFAULT_HOOK_PORT = 2018;
export const KAGERO_DEFAULT_APP_HOOK_PORT = 2019;
export const KAGERO_DEFAULT_OTLP_PORT = 4318;
export const KAGERO_DEFAULT_ADMIN_PORT = 2020;
/** Matches the agent's KAGERO_HOOK_TIMEOUT_MS fallback (config.rs). */
export const KAGERO_DEFAULT_HOOK_TIMEOUT_SECONDS = 10;

const RUNTIME_HOOKS = ["RUN", "RESUME", "SUSPEND", "TERMINATE"] as const;
const IMAGE_HOOKS = ["READY", "VALIDATE"] as const;

/**
 * Keys that look like secrets — ARNs are references, not secrets, and
 * pass via the (?!_ARN$) lookahead.
 */
const SECRET_KEY_RE =
  /(SECRET|TOKEN|PASSWORD|PASSPHRASE|CREDENTIAL|ACCESS_KEY|API_KEY|PRIVATE|BEARER|SIGNING|_KEY)(?!_ARN$)/i;

/** Agent env_safe charset (config.rs) — interpolated into templates. */
const ENV_SAFE_RE = /^[A-Za-z0-9._\-:/+=]*$/;

export interface KageroMicrovmConfig {
  /**
   * Backend selection. `both` is forwarded verbatim to the agent, but no
   * shipped collector template exports to two backends — pair it with a
   * custom `collectorConfigTemplate` (the agent warns at startup).
   */
  backend: "lgtm" | "cloudwatch" | "both";
  /** Billing baseline — env + optionally echoed into resources so
   *  dashboards and billing read the same number. */
  baselineGib: number;
  baselineVcpu: number;
  otlpEndpointLgtm?: string;
  otlpEndpointCloudwatch?: string;
  /**
   * Per-signal CloudWatch OTLP endpoint overrides (KAGERO_ENDPOINT_CW_*)
   * — for VPC endpoints only; the agent otherwise derives
   * xray./monitoring./logs.<region>.amazonaws.com from the region.
   */
  otlpEndpointCwTraces?: string;
  otlpEndpointCwMetrics?: string;
  otlpEndpointCwLogs?: string;
  /** Single-backend OTLP endpoint override (KAGERO_OTLP_ENDPOINT). */
  otlpEndpoint?: string;
  /** Hooks.Port + KAGERO_HOOK_PORT (default 2018, range 1–65535). */
  hookPort?: number;
  /**
   * Seconds (CFN range 1–60) applied to every runtime hook timeout
   * AND to KAGERO_HOOK_TIMEOUT_MS_{RUN,RESUME,SUSPEND,TERMINATE} in ms.
   * Default 10 (the agent's own fallback).
   */
  runtimeHookTimeoutSeconds?: number;
  /**
   * Seconds for READY/VALIDATE. CFN allows 1–3600 but the agent
   * rejects per-hook timeouts >300 s (config.rs), so this prop is
   * capped at 300. Default 10.
   */
  imageHookTimeoutSeconds?: number;
  /** KAGERO_HOOK_TIMEOUT_MS — fallback for hooks without an override. */
  hookTimeoutDefaultSeconds?: number;
  imageName?: string;
  imageVersion?: string;
  /** "2gb" style label reported on telemetry — default `${gib}gb`. */
  microvmSize?: string;
  region?: string;
  appUid?: number;
  appGid?: number;
  /** Comma-separated CIDR prefixes allowed on the hook port. */
  hookAllowedPeers?: string;
  /** Secrets Manager ARN the agent fetches at /run — a reference, not
   *  the secret itself (ADR-011 allows ARNs in env). */
  secretArn?: string;
  /** Secrets Manager REST endpoint override (KAGERO_SECRETS_ENDPOINT). */
  secretsEndpoint?: string;
  /** IMDS endpoint override (KAGERO_IMDS_ENDPOINT). */
  imdsEndpoint?: string;
  /** Collector supervision — without collectorBin the agent is
   *  supervisor-only and exports no telemetry. */
  collectorBin?: string;
  /** Only "build"/"run" exist in the agent today — the agent bails on
   *  anything else at boot (config.rs), so they aren't admitted. */
  collectorStart?: "build" | "run";
  /**
   * argv after the collector binary — emitted as KAGERO_COLLECTOR_ARGS
   * (a JSON array the agent parses at boot; a non-JSON value would
   * kill PID 1, so this prop takes the array, not the string).
   * `{config}` inside an arg is replaced by collectorConfigOut; a
   * non-empty list without the token gets the config path appended;
   * `[]` means no argv (env-file driven collectors like rotel).
   */
  collectorArgs?: string[];
  collectorConfigTemplate?: string;
  collectorConfigOut?: string;
  collectorReloadUrl?: string;
  tenantJsonPointer?: string;
  sessionJsonPointer?: string;
  cgroupPath?: string;
  sampleIntervalMs?: number;
  /** Fraction of each hook's timeout reserved for telemetry (0–1). */
  hookReserveFraction?: number;
  /** Extra non-secret env — secret-looking keys and keys the construct
   *  already manages are rejected (they'd silently drift). */
  extraEnvironment?: Record<string, string>;
  /** Disable hooks entirely (observability off, pass-through image). */
  hooksDisabled?: boolean;
}

export interface KageroMicrovmImageProps {
  /** Everything CfnMicrovmImage requires EXCEPT hooks/environment —
   *  this construct owns those two fields. */
  name: string;
  baseImageArn: string;
  baseImageVersion: string;
  buildRoleArn: string;
  codeArtifact: lambda.CfnMicrovmImage.CodeArtifactProperty;
  cpuConfigurations: lambda.CfnMicrovmImage.CpuConfigurationProperty[];
  description: string;
  egressNetworkConnectors: string[];
  logging: lambda.CfnMicrovmImage.LoggingProperty;
  resources: lambda.CfnMicrovmImage.ResourcesProperty[];
  additionalOsCapabilities?: string[];
  tags?: { key: string; value: string }[];
  kagero: KageroMicrovmConfig;
}

function checkRange(label: string, n: number, min: number, max: number): void {
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${label} must be an integer in [${min}, ${max}], got ${n}`);
  }
}

/** For legitimately fractional values (baseline sizes are f64 in the agent). */
function checkNumber(label: string, n: number, min: number, max: number): void {
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${label} must be in [${min}, ${max}], got ${n}`);
  }
}

function checkEnvSafe(label: string, v: string): void {
  if (!ENV_SAFE_RE.test(v)) {
    throw new Error(
      `${label} contains characters outside the agent's env_safe charset: ${JSON.stringify(v)}`,
    );
  }
}

/** Values rendered into collector YAML/river must not carry control
 *  chars — a `\n` (or NEL/U+2028 line break) corrupts the generated
 *  config (URLs need ?&%@ so the strict env_safe charset can't apply). */
function checkNoControlChars(label: string, v: string): void {
  for (const c of v) {
    const code = c.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      throw new Error(`${label} contains a control character: ${JSON.stringify(v)}`);
    }
  }
}

/** The env var list — pure for tests, single source for image+agent. */
export function kageroEnvironment(cfg: KageroMicrovmConfig): Record<string, string> {
  const env: Record<string, string> = {
    KAGERO_BACKEND: cfg.backend,
    KAGERO_HOOK_PORT: String(cfg.hookPort ?? KAGERO_DEFAULT_HOOK_PORT),
    KAGERO_APP_HOOK_PORT: String(KAGERO_DEFAULT_APP_HOOK_PORT),
    KAGERO_OTLP_PORT: String(KAGERO_DEFAULT_OTLP_PORT),
    KAGERO_ADMIN_PORT: String(KAGERO_DEFAULT_ADMIN_PORT),
    KAGERO_MICROVM_BASELINE_GIB: String(cfg.baselineGib),
    KAGERO_MICROVM_BASELINE_VCPU: String(cfg.baselineVcpu),
    KAGERO_MICROVM_SIZE: cfg.microvmSize ?? `${cfg.baselineGib}gb`,
  };
  if (cfg.otlpEndpoint) env.KAGERO_OTLP_ENDPOINT = cfg.otlpEndpoint;
  if (cfg.otlpEndpointLgtm) env.KAGERO_OTLP_ENDPOINT_LGTM = cfg.otlpEndpointLgtm;
  if (cfg.otlpEndpointCloudwatch) {
    env.KAGERO_OTLP_ENDPOINT_CLOUDWATCH = cfg.otlpEndpointCloudwatch;
  }
  if (cfg.otlpEndpointCwTraces) env.KAGERO_ENDPOINT_CW_TRACES = cfg.otlpEndpointCwTraces;
  if (cfg.otlpEndpointCwMetrics) env.KAGERO_ENDPOINT_CW_METRICS = cfg.otlpEndpointCwMetrics;
  if (cfg.otlpEndpointCwLogs) env.KAGERO_ENDPOINT_CW_LOGS = cfg.otlpEndpointCwLogs;
  // env_safe mirrors the agent's charset check (config.rs) — a stray
  // quote there would bail PID 1 at boot.
  for (const [label, v] of [
    ["imageName", cfg.imageName],
    ["imageVersion", cfg.imageVersion],
    ["microvmSize", cfg.microvmSize],
    ["region", cfg.region],
  ] as const) {
    if (v !== undefined) checkEnvSafe(label, v);
  }
  for (const [label, v] of [
    ["otlpEndpoint", cfg.otlpEndpoint],
    ["otlpEndpointLgtm", cfg.otlpEndpointLgtm],
    ["otlpEndpointCloudwatch", cfg.otlpEndpointCloudwatch],
    ["otlpEndpointCwTraces", cfg.otlpEndpointCwTraces],
    ["otlpEndpointCwMetrics", cfg.otlpEndpointCwMetrics],
    ["otlpEndpointCwLogs", cfg.otlpEndpointCwLogs],
    ["collectorConfigTemplate", cfg.collectorConfigTemplate],
    ["collectorConfigOut", cfg.collectorConfigOut],
    ["collectorReloadUrl", cfg.collectorReloadUrl],
  ] as const) {
    if (v !== undefined) checkNoControlChars(label, v);
  }
  if (cfg.imageName) env.KAGERO_MICROVM_IMAGE_NAME = cfg.imageName;
  if (cfg.imageVersion) env.KAGERO_MICROVM_IMAGE_VERSION = cfg.imageVersion;
  if (cfg.region) env.KAGERO_AWS_REGION = cfg.region;
  if (cfg.appUid !== undefined) env.KAGERO_APP_UID = String(cfg.appUid);
  if (cfg.appGid !== undefined) env.KAGERO_APP_GID = String(cfg.appGid);
  if (cfg.hookAllowedPeers) env.KAGERO_HOOK_ALLOWED_PEERS = cfg.hookAllowedPeers;
  if (cfg.secretArn) env.KAGERO_SECRET_ARN = cfg.secretArn;
  if (cfg.secretsEndpoint) env.KAGERO_SECRETS_ENDPOINT = cfg.secretsEndpoint;
  if (cfg.imdsEndpoint) env.KAGERO_IMDS_ENDPOINT = cfg.imdsEndpoint;
  if (cfg.collectorBin) env.KAGERO_COLLECTOR_BIN = cfg.collectorBin;
  if (cfg.collectorStart) env.KAGERO_COLLECTOR_START = cfg.collectorStart;
  if (cfg.collectorArgs) {
    if (!cfg.collectorArgs.every((a) => typeof a === "string")) {
      throw new Error("collectorArgs elements must all be strings (JSON array)");
    }
    env.KAGERO_COLLECTOR_ARGS = JSON.stringify(cfg.collectorArgs);
  }
  if (cfg.collectorConfigTemplate) {
    env.KAGERO_COLLECTOR_CONFIG_TEMPLATE = cfg.collectorConfigTemplate;
  }
  if (cfg.collectorConfigOut) env.KAGERO_COLLECTOR_CONFIG_OUT = cfg.collectorConfigOut;
  if (cfg.collectorReloadUrl) env.KAGERO_COLLECTOR_RELOAD_URL = cfg.collectorReloadUrl;
  if (cfg.tenantJsonPointer) env.KAGERO_TENANT_JSON_POINTER = cfg.tenantJsonPointer;
  if (cfg.sessionJsonPointer) env.KAGERO_SESSION_JSON_POINTER = cfg.sessionJsonPointer;
  if (cfg.cgroupPath) env.KAGERO_CGROUP_PATH = cfg.cgroupPath;
  if (cfg.sampleIntervalMs !== undefined) {
    env.KAGERO_SAMPLE_INTERVAL_MS = String(cfg.sampleIntervalMs);
  }
  if (cfg.hookReserveFraction !== undefined) {
    env.KAGERO_HOOK_RESERVE_FRACTION = String(cfg.hookReserveFraction);
  }
  if (cfg.hookTimeoutDefaultSeconds !== undefined) {
    env.KAGERO_HOOK_TIMEOUT_MS = String(cfg.hookTimeoutDefaultSeconds * 1000);
  }

  for (const hook of RUNTIME_HOOKS) {
    env[`KAGERO_HOOK_TIMEOUT_MS_${hook}`] = String(
      (cfg.runtimeHookTimeoutSeconds ?? KAGERO_DEFAULT_HOOK_TIMEOUT_SECONDS) * 1000,
    );
  }
  for (const hook of IMAGE_HOOKS) {
    env[`KAGERO_HOOK_TIMEOUT_MS_${hook}`] = String(
      (cfg.imageHookTimeoutSeconds ?? KAGERO_DEFAULT_HOOK_TIMEOUT_SECONDS) * 1000,
    );
  }

  for (const [k, v] of Object.entries(cfg.extraEnvironment ?? {})) {
    if (!/^[^\s]{1,256}$/.test(k)) {
      throw new Error(`env key ${JSON.stringify(k)} violates the CFN key rule (^[^\\s]{1,256}$)`);
    }
    if (SECRET_KEY_RE.test(k)) {
      throw new Error(
        `environment key "${k}" looks like a secret — secrets must not ` +
          "go in image env vars (ADR-011); use secretArn",
      );
    }
    // The construct owns the KAGERO_* namespace — a managed key that
    // happens to be unset would otherwise slip through with no
    // validation (uid 0, bogus reserve fraction → boot-time bail).
    if (k.startsWith("KAGERO_") || Object.hasOwn(env, k)) {
      throw new Error(
        `extraEnvironment key "${k}" is managed by the construct — ` +
          "use the dedicated prop so env and image config cannot drift",
      );
    }
    env[k] = v;
  }

  for (const [k, v] of Object.entries(env)) {
    if (v.length > 4096) {
      throw new Error(`env value for "${k}" exceeds the 4096-char CFN limit`);
    }
  }
  return env;
}

export class KageroMicrovmImage extends Construct {
  readonly image: lambda.CfnMicrovmImage;

  constructor(scope: Construct, id: string, props: KageroMicrovmImageProps) {
    super(scope, id);

    const cfg = props.kagero;
    // Baselines are f64 (0.5 GiB floor per research §1-2; vCPU ~2 GiB/vCPU).
    checkNumber("baselineGib", cfg.baselineGib, 0.5, 128);
    checkNumber("baselineVcpu", cfg.baselineVcpu, 0.125, 128);
    const hookPort = cfg.hookPort ?? KAGERO_DEFAULT_HOOK_PORT;
    checkRange("hookPort", hookPort, 1, 65535);
    // Runtime hooks: CFN range is 1–60 (aws-properties-lambda-
    // microvmimage-microvmhooks).
    const runtimeTimeout = cfg.runtimeHookTimeoutSeconds ?? KAGERO_DEFAULT_HOOK_TIMEOUT_SECONDS;
    checkRange("runtimeHookTimeoutSeconds", runtimeTimeout, 1, 60);
    // Image hooks: CFN allows 1–3600 but the agent bails on per-hook
    // timeouts above 300 s — cap at the agent's limit (config.rs).
    const imageTimeout = cfg.imageHookTimeoutSeconds ?? KAGERO_DEFAULT_HOOK_TIMEOUT_SECONDS;
    checkRange("imageHookTimeoutSeconds", imageTimeout, 1, 300);
    if (cfg.hookTimeoutDefaultSeconds !== undefined) {
      checkRange("hookTimeoutDefaultSeconds", cfg.hookTimeoutDefaultSeconds, 1, 300);
    }
    if (cfg.appUid === 0) {
      Annotations.of(this).addWarning(
        "appUid 0 runs the application as root — prefer a non-root uid",
      );
    }
    if (cfg.sampleIntervalMs !== undefined) {
      checkRange("sampleIntervalMs", cfg.sampleIntervalMs, 1, 3_600_000);
    }
    // u32 on the agent side — an out-of-range uid/gid parses to None
    // and silently changes privilege-drop semantics (config.rs).
    if (cfg.appUid !== undefined) checkRange("appUid", cfg.appUid, 0, 4_294_967_295);
    if (cfg.appGid !== undefined) checkRange("appGid", cfg.appGid, 0, 4_294_967_295);
    if (cfg.hookReserveFraction !== undefined) {
      const f = cfg.hookReserveFraction;
      if (!Number.isFinite(f) || f < 0 || f >= 1) {
        throw new Error(`hookReserveFraction must be in [0,1), got ${f}`);
      }
    }

    const enabled = cfg.hooksDisabled ? "DISABLED" : "ENABLED";

    // Seed the image-name fallback through kageroEnvironment so the
    // env_safe check and the managed-key guard both apply to it.
    const env = kageroEnvironment({ ...cfg, imageName: cfg.imageName || props.name });
    const environmentVariables = Object.entries(env).map(([key, value]) => ({ key, value }));
    if (environmentVariables.length > 50) {
      throw new Error(
        `MicrovmImage allows at most 50 env vars, got ${environmentVariables.length}`,
      );
    }

    const hooks: lambda.CfnMicrovmImage.HooksProperty = {
      port: hookPort,
      microvmHooks: {
        run: enabled,
        resume: enabled,
        suspend: enabled,
        terminate: enabled,
        runTimeoutInSeconds: runtimeTimeout,
        resumeTimeoutInSeconds: runtimeTimeout,
        suspendTimeoutInSeconds: runtimeTimeout,
        terminateTimeoutInSeconds: runtimeTimeout,
      },
      microvmImageHooks: {
        ready: enabled,
        validate: enabled,
        readyTimeoutInSeconds: imageTimeout,
        validateTimeoutInSeconds: imageTimeout,
      },
    };

    this.image = new lambda.CfnMicrovmImage(this, "Image", {
      name: props.name,
      baseImageArn: props.baseImageArn,
      baseImageVersion: props.baseImageVersion,
      buildRoleArn: props.buildRoleArn,
      codeArtifact: props.codeArtifact,
      cpuConfigurations: props.cpuConfigurations,
      description: props.description,
      egressNetworkConnectors: props.egressNetworkConnectors,
      logging: props.logging,
      resources: props.resources,
      additionalOsCapabilities: props.additionalOsCapabilities ?? [],
      tags: props.tags,
      hooks,
      environmentVariables,
    });
  }
}
