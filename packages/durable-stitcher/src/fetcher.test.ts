import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lambdaApiFetcher } from "./fetcher.js";

const ARN =
  "arn:aws:lambda:us-east-1:123456789012:function:checkout:$LATEST/durable-execution/order-7/9f7d84c9-ea3d-3ffc-b3e5-5ec51c34ffc9";
const HISTORY_PREFIX = "/2025-12-01/durable-executions/";

// GetDurableExecutionHistory split across two pages: the step starts on
// the first page and ends on the second.
const PAGES: Record<string, unknown> = {
  "": {
    Events: [
      { EventId: 1, EventType: "ExecutionStarted", EventTimestamp: 1750000000 },
      { EventId: 2, EventType: "StepStarted", EventTimestamp: 1750000001, Id: "s1", Name: "a" },
    ],
    NextMarker: "page-2",
  },
  "page-2": {
    Events: [
      { EventId: 3, EventType: "StepSucceeded", EventTimestamp: 1750000009, Id: "s1" },
      { EventId: 4, EventType: "ExecutionSucceeded", EventTimestamp: 1750000010 },
    ],
  },
};

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
}

let server: Server;
let base: string;
let seen: Seen[];

beforeEach(async () => {
  seen = [];
  server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://local");
    seen.push({
      method: req.method ?? "",
      path: u.pathname,
      query: u.searchParams,
    });
    req.resume();
    req.on("end", () => {
      if (req.method !== "GET" || !u.pathname.startsWith(HISTORY_PREFIX)) {
        res.writeHead(200).end();
        return;
      }
      const page = PAGES[u.searchParams.get("Marker") ?? ""];
      if (!page) {
        res.writeHead(400).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(page));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // The real SDK client talks to the local server with static test
  // credentials — no profile or AWS config file of the host is read.
  vi.stubEnv("AWS_ENDPOINT_URL_LAMBDA", base);
  vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIDEXAMPLE");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret");
  vi.stubEnv("AWS_PROFILE", undefined);
  vi.stubEnv("AWS_CONFIG_FILE", join(tmpdir(), "kagero-test-no-aws-config"));
  vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", join(tmpdir(), "kagero-test-no-aws-credentials"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("lambdaApiFetcher", () => {
  it("pages through NextMarker with the SDK client and concatenates the events", async () => {
    const rec = await lambdaApiFetcher({ region: "us-east-1" }).getHistory(ARN);

    const reqs = seen.filter((s) => s.path.startsWith(HISTORY_PREFIX));
    expect(reqs.map((r) => r.method)).toEqual(["GET", "GET"]);
    for (const r of reqs) {
      expect(decodeURIComponent(r.path)).toBe(`${HISTORY_PREFIX}${ARN}/history`);
      expect(r.query.get("IncludeExecutionData")).toBe("false");
    }
    expect(reqs.map((r) => r.query.get("Marker"))).toEqual([null, "page-2"]);

    expect(rec.status).toBe("succeeded");
    expect(rec.name).toBe("order-7");
    expect(rec.startTime).toEqual(new Date(1750000000 * 1000));
    expect(rec.endTime).toEqual(new Date(1750000010 * 1000));
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]?.status).toBe("succeeded");
    expect(rec.events[0]?.endTime).toEqual(new Date(1750000009 * 1000));
  });
});
