// ── ops-manager seed conservation (openspec: fleet-ops-manager task 3.1) ─────
//
// The manager's safety rests on ONE structural fact: its tool face cannot apply
// or publish. That is a property of the seed JSON, and a property nobody re-checks
// rots. This pins two things:
//   1. the seed is a valid pack manifest (break it → this goes red);
//   2. its mcpServers allowTools carry NO landing/approval/publish tool — and the
//      checker that proves it actually fires on a smuggled fleet_apply.
//
//   node --test scripts/test-fleet-ops-manager-seed.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { validatePackManifest } from "../lib/pack-manifest.js";

const seed = JSON.parse(readFileSync(new URL("../docs/ops-manager.seed.json", import.meta.url), "utf8"));

// Tools a manager must NEVER hold: landing, approval, publish, cast.
const FORBIDDEN = new Set([
  "fleet_apply",
  "facet_market_pack_publish",
  "publish",
  "publishVersion",
  "cast",
  "approve",
  "fleet_start",
  "fleet_archive",
]);
// Tools a manager MUST hold to do its job.
const REQUIRED = ["fleet_turns_read", "fleet_draft", "propose_action"];

function allAllowTools(manifest) {
  return (Array.isArray(manifest.mcpServers) ? manifest.mcpServers : []).flatMap((s) =>
    Array.isArray(s?.allowTools) ? s.allowTools : [],
  );
}

// The convergence-style checker: returns the forbidden tools it finds (empty ok).
function toolfaceViolations(manifest, forbidden = FORBIDDEN) {
  return allAllowTools(manifest).filter((t) => forbidden.has(t));
}

test("seed passes pack manifest validation (no errors)", () => {
  const errors = validatePackManifest(seed);
  assert.deepEqual(errors, [], `ops-manager seed must stay valid: ${JSON.stringify(errors)}`);
});

test("seed tool face holds no landing/approval/publish tool (structural narrowing)", () => {
  assert.deepEqual(toolfaceViolations(seed), [], `seed must not hold: ${[...FORBIDDEN].join(", ")}`);
});

test("seed tool face holds the tools the manager needs", () => {
  const tools = new Set(allAllowTools(seed));
  for (const t of REQUIRED) assert.ok(tools.has(t), `manager needs '${t}'`);
});

test("NEGATIVE: a smuggled fleet_apply would be caught by the checker", () => {
  const smuggled = {
    ...seed,
    mcpServers: [
      ...seed.mcpServers,
      { registryName: "fleet-architect", allowTools: ["fleet_apply"] },
    ],
  };
  const v = toolfaceViolations(smuggled);
  assert.deepEqual(v, ["fleet_apply"], "the narrowness checker must flag an added fleet_apply");
});
