#!/usr/bin/env node
/**
 * kagero-sim — drive the real agent through a MicroVM lifecycle locally.
 *
 *   kagero-sim run
 *
 * Agent binary: KAGERO_AGENT_BIN or the default target/debug/kagero.
 *
 * Prereq: `cargo build -p kagero-agent`. Exits non-zero when any check
 * fails. `docker pause/unpause` approximation arrives with the container
 * image (architecture.md §10); hook-only mode covers ordering + flush.
 */
import { runE2E } from "./e2e.js";

const args = process.argv.slice(2);
const cmd = args[0] ?? "run";
if (cmd === "run") {
  const { checks, ok } = await runE2E();
  for (const c of checks) {
    console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
  }
  console.log(ok ? "E2E OK" : "E2E FAILED");
  if (!ok) process.exit(1);
} else {
  console.error("usage: kagero-sim run");
  process.exit(2);
}
