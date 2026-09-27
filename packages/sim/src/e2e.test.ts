import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentBin, runE2E } from "./e2e.js";

// Needs the real binary (`cargo build -p kagero-agent`). Skipped when it
// is absent so pure-TS runs stay green; CI builds it first.
describe.skipIf(!existsSync(agentBin))("agent E2E", () => {
  it("drives a full lifecycle and verifies the contract", { timeout: 120_000 }, async () => {
    const { checks, ok } = await runE2E();
    for (const c of checks) {
      expect.soft(c.ok, `${c.name}${c.detail ? ` (${c.detail})` : ""}`).toBe(true);
    }
    expect(ok).toBe(true);
  });
});
