import { describe, expect, it } from "vitest";
import { resolveSecretArns, secretBinaryText } from "./index.js";

describe("resolveSecretArns", () => {
  it("resolves *_SECRET_ARN vars to their base name", async () => {
    const out = await resolveSecretArns(
      {
        KAGERO_OTLP_HEADER_SECRET_ARN: "arn:aws:secretsmanager:r:1:secret:h",
        KAGERO_OTLP_ENDPOINT: "https://example.com",
      },
      async (id) => `resolved:${id}`,
    );
    expect(out.KAGERO_OTLP_HEADER).toBe("resolved:arn:aws:secretsmanager:r:1:secret:h");
    expect(out.KAGERO_OTLP_ENDPOINT).toBe("https://example.com");
  });

  it("prefers an explicit plaintext var over the secret", async () => {
    const out = await resolveSecretArns(
      {
        KAGERO_GRAFANA_TOKEN: "explicit",
        KAGERO_GRAFANA_TOKEN_SECRET_ARN: "arn:aws:secretsmanager:r:1:secret:t",
      },
      async () => "from-secret",
    );
    expect(out.KAGERO_GRAFANA_TOKEN).toBe("explicit");
  });

  it("throws when the secret has no value", async () => {
    await expect(
      resolveSecretArns({ FOO_SECRET_ARN: "arn:x" }, async () => undefined),
    ).rejects.toThrow(/no value/);
  });

  it("ignores non-secret vars and empty arns", async () => {
    const out = await resolveSecretArns({ A: "1", B_SECRET_ARN: "" }, async () => {
      throw new Error("must not fetch");
    });
    expect(out).toEqual({ A: "1", B_SECRET_ARN: "" });
  });
});

describe("secretBinaryText", () => {
  const enc = new TextEncoder();

  it("keeps a leading BOM like the agent's String::from_utf8", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode("tok")]);
    expect(secretBinaryText(bytes)).toBe("﻿tok");
  });

  it("rejects non-UTF8 bytes", () => {
    expect(() => secretBinaryText(new Uint8Array([0xff, 0xfe]))).toThrow();
  });
});
