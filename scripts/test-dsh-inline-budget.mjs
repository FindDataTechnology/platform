// The inline budget for retained tool output (fix-dsh-inline-budget).
//
// dsh ships `spill-policy` with maxInlineTokens 12500 (~40KB). The traced
// overflowing rounds showed single tool results at 40KB and single assistant
// messages at 43KB — 79-87% of the round's bytes, while everything the platform
// injects (template + rendered fleetContext) was 13-21%. On a 128K window that
// stock budget lets two results eat a fifth of the context, and the round dies
// at `context overflow` after ONE compaction.
//
// The platform already composes this patch file (it writes the llm row), so the
// budget is ours to set. Retained text is spilled to disk with a reference —
// a smaller inline budget costs a re-read, never the information.
//
// Run: node --test scripts/test-dsh-inline-budget.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import yaml from "js-yaml";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "inline-budget-"));
process.env.DSH_HOME = tmpRoot;

const { inlineTokensBudget, writeLlmProfile } = await import("../dsh-profile.js");

test("budget: default 4000, env-overridable, never zero", () => {
  assert.equal(inlineTokensBudget({}), 4000);
  assert.equal(inlineTokensBudget({ DSH_MAX_INLINE_TOKENS: "8000" }), 8000);
  assert.equal(inlineTokensBudget({ DSH_MAX_INLINE_TOKENS: "12500" }), 12500, "rollback value is accepted verbatim");
  assert.equal(inlineTokensBudget({ DSH_MAX_INLINE_TOKENS: "abc" }), 4000, "garbage falls back to the default");
  assert.equal(inlineTokensBudget({ DSH_MAX_INLINE_TOKENS: "0" }), 4000, "0 would suppress every body — refuse it");
  assert.equal(inlineTokensBudget({ DSH_MAX_INLINE_TOKENS: "-5" }), 4000);
});

test("writeLlmProfile composes the spill-policy row with the budget", async () => {
  const profileDir = path.join(tmpRoot, "profiles", "platform");
  fs.mkdirSync(profileDir, { recursive: true });
  const patchPath = path.join(profileDir, "cordis.patch.yml");
  // A real scaffold shape: one insert block plus a stale platform row.
  fs.writeFileSync(patchPath, yaml.dump([
    { insert: [{ id: "sdk-jsonrpc-server", name: "@deepseek-ai/dsh-sdk-jsonrpc-server" }] },
    { id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai", config: { providers: {} } },
    { id: "spill-policy", name: "@deepseek-ai/dsh-spill-policy", config: { maxInlineTokens: 12500 } },
  ]));

  delete process.env.DSH_MAX_INLINE_TOKENS;
  await writeLlmProfile({ dirs: { dshHome: tmpRoot, profileName: "platform" } });

  const rows = yaml.load(fs.readFileSync(patchPath, "utf8"));
  const spill = rows.filter((r) => r && r.id === "spill-policy");
  assert.equal(spill.length, 1, "exactly one spill-policy row — the stale one is replaced, not duplicated");
  assert.equal(spill[0].config.maxInlineTokens, 4000);
  assert.ok(rows.some((r) => r?.insert), "the scaffold's insert block survives");
  assert.equal(rows.filter((r) => r?.id === "llm-pi-ai").length, 1, "and the llm row is still single");
});

test("the env override reaches the written patch", async () => {
  const profileDir = path.join(tmpRoot, "profiles", "platform");
  const patchPath = path.join(profileDir, "cordis.patch.yml");
  process.env.DSH_MAX_INLINE_TOKENS = "8000";
  await writeLlmProfile({ dirs: { dshHome: tmpRoot, profileName: "platform" } });
  const rows = yaml.load(fs.readFileSync(patchPath, "utf8"));
  assert.equal(rows.find((r) => r?.id === "spill-policy").config.maxInlineTokens, 8000);
  delete process.env.DSH_MAX_INLINE_TOKENS;
});

test.after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});
