#!/usr/bin/env node
/**
 * kagero-sim — drive the real agent through a MicroVM lifecycle locally.
 *
 *   kagero-sim run
 *
 * Agent binary: KAGERO_AGENT_BIN or the default target/debug/kagero.
 *
 * Prereq: `cargo build -p kagero-agent`. Exits non-zero when any check
 * fails. Hook-only: /suspend and /resume are plain hook calls — nothing
 * freezes the processes (no `docker pause/unpause` approximation), so
 * the run covers hook ordering + flush, not snapshot behaviour.
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
