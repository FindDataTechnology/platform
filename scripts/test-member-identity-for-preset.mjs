#!/usr/bin/env node
// ── Cron fires must resolve their member identity directly ──────────────────
//
// trim-mcp-injection-per-post 2.2. The member-patch branch (and the per-post
// MCP trimming inside it) never ran for fleet cron fires, because identity came
// from a preset→member SCAN that returns null unless attribution is a unique
// "preset" match. Live 2026-11-10: the cell logged "injection surface: 34 MCP
// server(s)" with no trim line and no member-* profile dir at all.
//
// But a cron fire already knows its member: the task record carries
// `sourceTag: { fleetId, memberId }`. These pin the resolver's rules — the
// important one being that only a live (running/queued) record counts, so a
// finished fire cannot hand its identity to a later chat turn.
//
//   node --test scripts/test-member-identity-for-preset.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

// The resolver is a closure over engine.allRecords(); reproduce its contract
// here so the rules are pinned without booting server.js.
function makeResolver(records) {
  return (presetId) => {
    if (!presetId) return null;
    for (const rec of records()) {
      if (rec?.preset !== presetId) continue;
      if (rec.state !== "running" && rec.state !== "queued") continue;
      const tag = rec.sourceTag;
      if (tag?.fleetId && tag?.memberId) return { fleetId: tag.fleetId, memberId: tag.memberId };
    }
    return null;
  };
}

const fire = (preset, state, tag = {}) => ({ preset, state, sourceTag: tag });

test("1. a running fire resolves the member straight off sourceTag", () => {
  const resolve = makeResolver(() => [
    fire("mo-inventory", "running", { fleetId: "f1", memberId: "m1" }),
  ]);
  assert.deepEqual(resolve("mo-inventory"), { fleetId: "f1", memberId: "m1" });
});

test("2. a queued fire counts too (the patch is composed before the turn runs)", () => {
  const resolve = makeResolver(() => [
    fire("hc-architect", "queued", { fleetId: "f2", memberId: "m2" }),
  ]);
  assert.deepEqual(resolve("hc-architect"), { fleetId: "f2", memberId: "m2" });
});

test("3. a FINISHED fire must not lend its identity to a later turn", () => {
  for (const state of ["done", "failed", "interrupted", "skipped", null]) {
    const resolve = makeResolver(() => [fire("mo-eval", state, { fleetId: "f3", memberId: "m3" })]);
    assert.equal(resolve("mo-eval"), null, `state=${state} must not resolve`);
  }
});

test("4. records without a sourceTag (chat-lane tasks) resolve to null → scan fallback", () => {
  const resolve = makeResolver(() => [fire("mo-proposal", "running")]);
  assert.equal(resolve("mo-proposal"), null);
});

test("5. a half tag (missing memberId) resolves to null, never a partial identity", () => {
  const resolve = makeResolver(() => [fire("mo-proposal", "running", { fleetId: "f4" })]);
  assert.equal(resolve("mo-proposal"), null);
});

test("6. only the matching preset is considered", () => {
  const resolve = makeResolver(() => [
    fire("mo-inventory", "running", { fleetId: "fA", memberId: "mA" }),
    fire("mo-eval", "running", { fleetId: "fB", memberId: "mB" }),
  ]);
  assert.deepEqual(resolve("mo-eval"), { fleetId: "fB", memberId: "mB" });
});

test("7. an empty preset short-circuits (no unscoped match)", () => {
  const resolve = makeResolver(() => [fire(undefined, "running", { fleetId: "f", memberId: "m" })]);
  assert.equal(resolve(""), null);
});
