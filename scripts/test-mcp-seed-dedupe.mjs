#!/usr/bin/env node
// ── One program, one MCP row (2026-11-09 live finding) ──────────────────────
//
// The deployment baseline (mcp.json) and the packaged bundle
// (platform.bundle.json) name the actions bridge differently — `actions` vs
// `actions-mcp` — while both point at server/actions-mcp.js. Seeding keys on
// NAME, so a hosted cell got both rows and then:
//   - every dsh spawned the script twice (~80Mi each),
//   - the roster offered `propose_action` under two servers,
//   - the bundle copy carried no ACTIONS_MCP_PROPOSER_EMAIL, so its proposals
//     were stored with proposer_email NULL — and the approve path requires
//     `userEmail === proposer`, which NULL can never satisfy (a dead end).
//
// This pins the predicate the seeding now uses. server.js is not importable
// (it boots), so the decision lives in extension-store.js and is tested here.
//
// Run: node --test scripts/test-mcp-seed-dedupe.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { findSameProgram, mcpProgramKey } from "../extension-store.js";

const actions = { command: "node", args: ["server/actions-mcp.js"] };
const fleet = { command: "node", args: ["server/fleet-mcp.js"] };

test("the deployment name and the bundle name of one script collide", () => {
  assert.equal(mcpProgramKey(actions), mcpProgramKey({ ...actions }), "same script → same key");
  // The real shape: these are two rows with different names, identical programs.
  const rows = [{ name: "actions", config: actions, enabled: true }];
  assert.equal(findSameProgram(rows, { ...actions }), "actions");
  assert.equal(findSameProgram(rows, { ...actions }, { excludeName: "actions" }), null, "a row is never its own twin");
});

test("different scripts never collide, even with the same command", () => {
  const rows = [{ name: "fleet", config: fleet, enabled: true }];
  assert.equal(findSameProgram(rows, actions), null);
});

test("a disabled twin does not block the seed (disabling one name keeps the other)", () => {
  const rows = [{ name: "actions", config: actions, enabled: false }];
  assert.equal(findSameProgram(rows, { ...actions }), null, "otherwise turning `actions` off would remove both");
});

test("rows without a command (url servers) never collide", () => {
  const rows = [{ name: "facet", config: { url: "https://x/mcp" }, enabled: true }];
  assert.equal(mcpProgramKey({ url: "https://y/mcp" }), "", "no command → empty program key");
  assert.equal(findSameProgram(rows, { url: "https://y/mcp" }), null, "url servers are matched by name, not program");
});
