/**
 * Mock OTLP/HTTP collector. Stands in for the in-MicroVM collector at
 * 127.0.0.1:<otlp_port>: captures every POST /v1/{logs,metrics,traces}
 * body so tests can assert on what the agent (or app) emitted, in the
 * order it arrived.
 */
import { createServer, type Server } from "node:http";

export interface OtlpCapture {
  /** /v1/logs, /v1/metrics, /v1/traces or any other path. */
  path: string;
  /** Parsed JSON body, or raw text when not JSON. */
  body: unknown;
}

export interface MockOtlp {
  url: string;
  port: number;
  captures(): OtlpCapture[];
  close(): Promise<void>;
}

export async function startMockOtlp(port = 0): Promise<MockOtlp> {
  const received: OtlpCapture[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // keep raw
      }
      received.push({ path: req.url ?? "", body });
      // OTel HTTP exporters expect 200 + {} (full success).
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address();
  const bound = typeof addr === "object" && addr ? addr.port : port;
  return {
    url: `http://127.0.0.1:${bound}`,
    port: bound,
    captures: () => [...received],
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // Keep-alive sockets would otherwise hold `close` open.
        server.closeAllConnections();
      }),
  };
}
