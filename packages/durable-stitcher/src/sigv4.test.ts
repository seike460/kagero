import { describe, expect, it } from "vitest";
import { canonicalQuery, credsFromEnv, signRequest } from "./sigv4.js";

const CREDS = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  sessionToken: "token123",
};

describe("signRequest", () => {
  const req = {
    method: "POST",
    host: "monitoring.us-east-1.amazonaws.com",
    path: "/v1/traces",
    headers: { "content-type": "application/json" },
    body: Buffer.from('{"a":1}'),
  };

  it("produces a deterministic signature for fixed inputs", () => {
    const now = new Date("2026-09-01T12:00:00Z");
    const a = signRequest(req, CREDS, "us-east-1", "monitoring", now);
    const b = signRequest(req, CREDS, "us-east-1", "monitoring", now);
    expect(a).toEqual(b);
    expect(a.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260901\/us-east-1\/monitoring\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
    );
    expect(a["x-amz-date"]).toBe("20260901T120000Z");
    expect(a["x-amz-security-token"]).toBe("token123");
    expect(a.host).toBe("monitoring.us-east-1.amazonaws.com");
  });

  it("changes the signature when the body changes", () => {
    const now = new Date("2026-09-01T12:00:00Z");
    const a = signRequest(req, CREDS, "us-east-1", "monitoring", now);
    const b = signRequest(
      { ...req, body: Buffer.from('{"a":2}') },
      CREDS,
      "us-east-1",
      "monitoring",
      now,
    );
    expect(a.authorization).not.toBe(b.authorization);
  });

  it("changes the signature when the path changes", () => {
    const now = new Date("2026-09-01T12:00:00Z");
    const a = signRequest(req, CREDS, "us-east-1", "monitoring", now);
    const b = signRequest(
      { ...req, path: "/otlp/v1/traces" },
      CREDS,
      "us-east-1",
      "monitoring",
      now,
    );
    expect(a.authorization).not.toBe(b.authorization);
  });

  it("omits the session token header when absent", () => {
    const h = signRequest(
      req,
      { accessKeyId: "AKID", secretAccessKey: "SECRET" },
      "us-east-1",
      "monitoring",
      new Date("2026-09-01T12:00:00Z"),
    );
    expect(h["x-amz-security-token"]).toBeUndefined();
  });
});

describe("canonicalQuery", () => {
  it("sorts params and re-encodes to the RFC3986 unreserved set", () => {
    // Order-insensitive, space → %20 (not +), ! ' ( ) * get %XX-encoded.
    expect(canonicalQuery("b=2&a=1")).toBe("a=1&b=2");
    expect(canonicalQuery("a=1&b=2")).toBe("a=1&b=2");
    expect(canonicalQuery("q=hello world")).toBe("q=hello%20world");
    expect(canonicalQuery("x=a'b")).toBe("x=a%27b");
    expect(canonicalQuery("x=%2F")).toBe("x=%2F"); // decoded then re-encoded
    expect(canonicalQuery("z=&a=")).toBe("a=&z=");
    expect(canonicalQuery("")).toBe("");
  });

  it("produces the same signature for differently-ordered raw queries", () => {
    const now = new Date("2026-09-01T12:00:00Z");
    const req = {
      method: "POST",
      host: "monitoring.us-east-1.amazonaws.com",
      path: "/v1/metrics",
      headers: { "content-type": "application/json" },
      body: Buffer.from("{}"),
    };
    const a = signRequest(
      { ...req, query: canonicalQuery("b=2&a=1") },
      CREDS,
      "us-east-1",
      "monitoring",
      now,
    );
    const b = signRequest(
      { ...req, query: canonicalQuery("a=1&b=2") },
      CREDS,
      "us-east-1",
      "monitoring",
      now,
    );
    expect(a.authorization).toBe(b.authorization);
  });
});

describe("credsFromEnv", () => {
  it("reads standard Lambda credential env vars", () => {
    const c = credsFromEnv({
      AWS_ACCESS_KEY_ID: "AKID",
      AWS_SECRET_ACCESS_KEY: "SECRET",
      AWS_SESSION_TOKEN: "TOK",
    } as NodeJS.ProcessEnv);
    expect(c?.accessKeyId).toBe("AKID");
    expect(c?.sessionToken).toBe("TOK");
  });
  it("returns undefined without both keys", () => {
    expect(credsFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(credsFromEnv({ AWS_ACCESS_KEY_ID: "AKID" } as NodeJS.ProcessEnv)).toBeUndefined();
  });
});
