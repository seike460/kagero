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

describe("signRequest known answers", () => {
  const AWS_EXAMPLE = {
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  };
  const STS_TOKEN =
    "AQoDYXdzEPT//////////wEXAMPLEtc764bNrC9SAPBSM22wDOk4x4HIZ8j4FZTwdQWLWsKWHGBuFqwAeMicRXmxfpSPfIeoIYRqTflfKD8YUuwthAx7mSEI/qkPpKPi/kMcGdQrmGdeehM4IC1NtBmUpp2wUE8phUZampKsburEDy0KPkyQDYwT7WZ0wq5VSXDvp75YU9HFvlRd8Tx6q6fE8YQcHNVXAkiY9q6d+xo0rKwT38xVqr7ZD0u0iPPkUL64lIZbqBAz+scqKmlzm8FDrypNC9Yjc8fPOLn9FX9KSYvKTr4rvx3iSIlTJabIQwj2ICCR/oLxBA==";
  const now = new Date("2015-08-30T12:36:00Z");

  it("matches the AWS documentation example (IAM ListUsers)", () => {
    // Same vector as crates/kagero-agent/src/sigv4.rs.
    const h = signRequest(
      {
        method: "GET",
        host: "iam.amazonaws.com",
        path: "/",
        query: "Action=ListUsers&Version=2010-05-08",
        headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
        body: Buffer.alloc(0),
      },
      AWS_EXAMPLE,
      "us-east-1",
      "iam",
      now,
    );
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-date, " +
        "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
  });

  // Vectors from the SigV4 test suite (awslabs/aws-c-auth,
  // tests/aws-signing-test-suite/v4/<name>/header-signed-request.txt).
  it("matches post-x-www-form-urlencoded (signed body)", () => {
    const h = signRequest(
      {
        method: "POST",
        host: "example.amazonaws.com",
        path: "/",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": "13",
          "x-amz-content-sha256":
            "9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e",
        },
        body: Buffer.from("Param1=value1"),
      },
      AWS_EXAMPLE,
      "us-east-1",
      "service",
      now,
    );
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, " +
        "Signature=d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b",
    );
  });

  it("matches post-sts-header-before (signed session token)", () => {
    const h = signRequest(
      {
        method: "POST",
        host: "example.amazonaws.com",
        path: "/",
        headers: {},
        body: Buffer.alloc(0),
      },
      { ...AWS_EXAMPLE, sessionToken: STS_TOKEN },
      "us-east-1",
      "service",
      now,
    );
    expect(h["x-amz-security-token"]).toBe(STS_TOKEN);
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date;x-amz-security-token, " +
        "Signature=85d96828115b5dc0cfc3bd16ad9e210dd772bbebba041836c64533a82be05ead",
    );
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
