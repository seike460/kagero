import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { httpSend } from "./otlp.js";

// A token in each part of the URL that may carry one.
const TOKENS = ["pw-tok", "path-tok", "query-tok"];

/** The rejection message of `p` — fails the test when `p` resolves. */
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String(e);
  }
  throw new Error("expected a rejection");
}

function expectNoTokens(text: string): void {
  for (const t of TOKENS) expect(text, `${t} leaked`).not.toContain(t);
}

/** host:port that refuses connections — a port just released. */
async function closedHost(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as { port: number };
  await new Promise<void>((r) => s.close(() => r()));
  return `127.0.0.1:${port}`;
}

describe("httpSend errors", () => {
  let server: Server;
  let host: string;

  beforeEach(async () => {
    // Echoes the request line, as some servers do in an error body.
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => res.writeHead(401).end(`Cannot POST ${req.url}`));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    host = `127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const body = Buffer.from("{}");

  it("names the host and the status, not the path, the query or the body", async () => {
    const msg = await rejection(
      httpSend().post(`http://${host}/path-tok/v1/traces?q=query-tok`, body, {}),
    );
    expectNoTokens(msg);
    expect(msg).not.toContain("Cannot POST");
    expect(msg).toContain(`OTLP POST to http://${host} returned HTTP 401`);
  });

  it("keeps the URL out when fetch itself fails", async () => {
    // fetch quotes the whole URL when it refuses userinfo or cannot parse it.
    const withUserinfo = await rejection(
      httpSend().post(`http://user:pw-tok@${host}/path-tok/v1/traces?q=query-tok`, body, {}),
    );
    expectNoTokens(withUserinfo);
    expect(withUserinfo).toContain(`OTLP POST to http://REDACTED@${host} failed: TypeError`);

    const unparsable = await rejection(
      httpSend().post("otlp.example.com/path-tok/v1/traces?q=query-tok", body, {}),
    );
    expectNoTokens(unparsable);
    expect(unparsable).toContain("OTLP POST to an invalid URL failed: TypeError (ERR_INVALID_URL)");

    const closed = await closedHost();
    const refused = await rejection(
      httpSend().post(`http://${closed}/path-tok/v1/traces?q=query-tok`, body, {}),
    );
    expectNoTokens(refused);
    expect(refused).toContain(`OTLP POST to http://${closed} failed: TypeError (ECONNREFUSED)`);
  });
});
