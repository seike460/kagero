/**
 * AWS Signature Version 4 signer for OTLP HTTP posts to CloudWatch. The
 * caller picks the service name per signal — "xray" for traces,
 * "monitoring" for metrics, as in collector/cloudwatch sigv4auth.
 * The stitcher is a plain Lambda: its execution-role credentials arrive
 * as environment variables, and X-Ray/CloudWatch OTLP endpoints require
 * signed requests. PoC-08 verifies the real endpoint + service name.
 */
import { createHash, createHmac } from "node:crypto";

export interface AwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignableRequest {
  method: string;
  /** e.g. "monitoring.us-east-1.amazonaws.com" */
  host: string;
  /** e.g. "/v1/traces" */
  path: string;
  query?: string;
  headers: Record<string, string>;
  /** Raw request body bytes. */
  body: Buffer;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest();
const hmacHex = (key: string | Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest("hex");

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function canonicalHeaders(headers: Record<string, string>): { list: string; signed: string } {
  const pairs = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase().trim(), v.replace(/\s+/g, " ").trim()] as const)
    // Bytewise sort — SigV4 defines byte order, and localeCompare is
    // locale-sensitive (can reorder non-ASCII header names).
    .sort(([a], [b]) => cmp(a, b));
  return {
    list: `${pairs.map(([k, v]) => `${k}:${v}`).join("\n")}\n`,
    signed: pairs.map(([k]) => k).join(";"),
  };
}

/**
 * Canonicalize a raw query string for SigV4: decode each name/value,
 * re-encode per RFC3986 (SigV4 unreserved set), and sort by encoded name
 * then value. Passing `u.search.slice(1)` through un-normalized signs a
 * different string than AWS recomputes when parameter order or encoding
 * differs.
 */
export function canonicalQuery(raw: string): string {
  if (!raw) return "";
  const enc = (s: string) =>
    encodeURIComponent(s).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  // Manual parse — URLSearchParams decodes "+" as a space, but SigV4
  // treats "+" as a literal character to re-encode as %2B (decodeURIComponent
  // keeps it literal, matching AWS's canonicalization).
  const dec = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s; // malformed %xx — pass through, encoded verbatim below
    }
  };
  const pairs: [string, string][] = [];
  for (const part of raw.split("&")) {
    if (part === "") continue;
    const i = part.indexOf("=");
    const [k, v] = i < 0 ? [part, ""] : [part.slice(0, i), part.slice(i + 1)];
    pairs.push([enc(dec(k)), enc(dec(v))]);
  }
  pairs.sort((a, b) => (a[0] === b[0] ? cmp(a[1], b[1]) : cmp(a[0], b[0])));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

/**
 * Sign a request, returning the headers to send (input headers plus
 * x-amz-date, authorization, and x-amz-security-token when present).
 */
export function signRequest(
  req: SignableRequest,
  creds: AwsCreds,
  region: string,
  service: string,
  now = new Date(),
): Record<string, string> {
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    ...req.headers,
    host: req.host,
    "x-amz-date": amzDate,
  };
  if (creds.sessionToken) headers["x-amz-security-token"] = creds.sessionToken;

  const { list: canHeaders, signed: signedHeaders } = canonicalHeaders(headers);
  const canonical = [
    req.method,
    req.path,
    req.query ?? "",
    canHeaders,
    signedHeaders,
    sha256(req.body),
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");

  const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmacHex(kSigning, toSign);

  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** Read signing credentials from Lambda's environment (execution role). */
export function credsFromEnv(env: NodeJS.ProcessEnv = process.env): AwsCreds | undefined {
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return undefined;
  const c: AwsCreds = { accessKeyId, secretAccessKey };
  if (env.AWS_SESSION_TOKEN) c.sessionToken = env.AWS_SESSION_TOKEN;
  return c;
}
