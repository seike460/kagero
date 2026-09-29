/**
 * @kagero/secrets — resolves KAGERO_*_SECRET_ARN env vars into their
 * plaintext counterparts at cold start (ADR-011: ARNs may sit in env,
 * secrets must not).
 *
 * Convention: `KAGERO_FOO_SECRET_ARN` holds a Secrets Manager ARN;
 * at init it is fetched once and exposed as `KAGERO_FOO`. An explicit
 * `KAGERO_FOO` env var always wins over a resolved secret, so local
 * development keeps working without AWS. Secrets are cached for the
 * life of the warm execution environment — a rotation mid-flight is
 * picked up on the next cold start, not retroactively.
 */

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export const SECRET_ARN_SUFFIX = "_SECRET_ARN";

/** Injectable for tests. */
export type SecretFetcher = (secretId: string) => Promise<string | undefined>;

let sharedClient: SecretsManagerClient | undefined;
const defaultFetch: SecretFetcher = async (secretId) => {
  sharedClient ??= new SecretsManagerClient({});
  const out = await sharedClient.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (out.SecretString !== undefined) return out.SecretString;
  if (out.SecretBinary) {
    return secretBinaryText(out.SecretBinary);
  }
  return undefined;
};

/**
 * SecretBinary arrives as raw bytes — match the agent's contract
 * (crates/kagero-agent/src/secrets.rs): UTF-8 text, `ignoreBOM` so a
 * leading BOM is kept like Rust's `String::from_utf8`, `fatal` on
 * non-UTF8 rather than a re-encoded base64 string.
 */
export function secretBinaryText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

/**
 * Scan env for `*_SECRET_ARN` entries, fetch each, and return a new
 * env where the base name maps to the secret value. Plaintext vars
 * already present take precedence over a secret of the same name.
 * Unknown `*_SECRET_ARN` names are resolved under whatever base name
 * they carry — the function is deliberately generic.
 */
export async function resolveSecretArns(
  env: NodeJS.ProcessEnv,
  fetch: SecretFetcher = defaultFetch,
): Promise<NodeJS.ProcessEnv> {
  const out: NodeJS.ProcessEnv = { ...env };
  const pending: { key: string; base: string; arn: string }[] = [];
  for (const [key, arn] of Object.entries(env)) {
    if (!key.endsWith(SECRET_ARN_SUFFIX) || !arn) continue;
    const base = key.slice(0, -SECRET_ARN_SUFFIX.length);
    if (out[base] !== undefined) continue;
    pending.push({ key, base, arn });
  }
  // Parallel — cold-start latency matters.
  const values = await Promise.all(pending.map((p) => fetch(p.arn)));
  for (const [i, p] of pending.entries()) {
    const value = values[i];
    if (value === undefined) {
      throw new Error(`secret ${p.key} (${p.arn}) resolved to no value`);
    }
    out[p.base] = value;
  }
  return out;
}
