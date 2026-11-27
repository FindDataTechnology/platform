// Self-check for the catalog-agent persona presets (dsh-profile.js, 0.2.0
// declarative model).
//
// A vertical-pack agent is served LOCALLY: the deployment composes one preset
// row per chat-mode catalog entry from the platform-owned standard
// composition, swapping only the persona row's text. That is what keeps the
// pack chat on the local runtime — its tools, MCP servers, skills and session
// history — instead of forking to a bare remote model. The branches worth
// breaking: the persona swap tearing the composition, idempotence (the
// catalog is polled every minute), pruning a departed entry, and the defs
// file + preset overlay staying coherent.
//
// Runs entirely inside a temp DSH_HOME (set before the module loads, because
// dsh-profile resolves its paths at import time), so the developer's real
// ~/.dsh is never written.
//
// Run: node scripts/test-catalog-agent-presets.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-presets-"));
process.env.DSH_HOME = home;

const profile = await import("../dsh-profile.js");

// ── persona text ─────────────────────────────────────────────────────────────
const explicit = profile.catalogEntryPersona({ id: "pack-a", name: "A", description: "d", persona: "  你是 A。  " });
assert.ok(explicit.startsWith("你是 A。"), "an explicit persona is used verbatim");
assert.ok(explicit.includes("{{model}}"), "the runner line stays for the plugin to resolve");

const composed = profile.catalogEntryPersona({ id: "pack-a", name: "合同审查官", description: "法律-合同包对话入口", tags: ["法律", "合同"] });
assert.ok(composed.includes("合同审查官") && composed.includes("法律-合同包对话入口"), "name + description seed the persona");
assert.ok(composed.includes("不要凭记忆编造"), "the honesty rule is part of the generated persona");

// ── composition swap (data-level, 0.2.0) ────────────────────────────────────
// The 0.2.0 composition is the deployment-owned remainder: dsh-base composes
// the whole host plane, so what swaps is the persona prefix (+ the ask tool).
const rows = profile.composePresetRows("PROBE 你是合同审查官。");
const personaRow = rows.find((r) => r?.id === "persona");
assert.equal(personaRow?.config?.prefix, "PROBE 你是合同审查官。", "the persona row carries the new prefix");
assert.ok(!JSON.stringify(rows).includes("You are a coding agent powered"), "the template persona line is replaced");
assert.ok(rows.some((r) => r?.id === "tool-ask-user"), "the ask tool rides every composed preset");
assert.equal(rows.filter((r) => r?.name === "@deepseek-ai/dsh-persona").length, 1, "exactly one persona row");

// ── generation (defs + overlay) ──────────────────────────────────────────────
const entries = [
  { id: "pack-contract-reviewer", type: "agent-remote", mode: "chat", name: "合同审查官", description: "法律-合同包对话入口", baseUrl: "https://x/v1", model: "m" },
  { id: "pack-link", type: "agent-remote", mode: "link", name: "Link", url: "https://example.com" },
  { id: "standard", type: "agent-remote", mode: "chat", name: "Shadow", description: "may not shadow the platform preset", baseUrl: "https://x/v1", model: "m" },
];
const first = profile.writeCatalogAgentPresets(entries);
assert.deepEqual(first.ids, ["pack-contract-reviewer"], "only chat-mode entries with a free id become presets");
assert.equal(first.changed, true, "first generation reports a change");
const defsFile = path.join(home, ".agent-presets.defs.json");
assert.ok(fs.existsSync(defsFile), "the definition set persists across restarts");
const overlayPath = path.join(home, "profiles", "platform", "presets.patch.yml");
assert.ok(fs.existsSync(overlayPath), "the preset overlay is (re)written");
const overlay = fs.readFileSync(overlayPath, "utf8");
assert.ok(overlay.includes("@deepseek-ai/dsh-agent-preset-registry"), "the registry row is composed");
assert.ok(overlay.includes("id: preset-standard"), "the standard preset row is composed");
assert.ok(overlay.includes("id: preset-pack-contract-reviewer"), "the persona preset row is composed");
assert.ok(overlay.includes("合同审查官"), "the persona text rides the row");
assert.ok(overlay.includes("platform-preset-bridge.js"), "the bridge row survives");
assert.ok(profile.hasCatalogAgentPreset("pack-contract-reviewer"), "the id resolves to a local preset");
assert.ok(!profile.hasCatalogAgentPreset("pack-link"), "a link entry has no preset");

// Fold (live defect 2026-10-09 heritage): every id that reaches a roster row
// must land in the lowercase alphabet the old containment regex enforced —
// marketplace pack ids are case-mixed base64url and may carry `_`/dots.
assert.equal(profile.rosterPresetId("qnhd7B3J1-HKDDKzZQ_fUQ"), "qnhd7b3j1-hkddkzzq-fuq", "case-mixed base64url ids fold to the roster alphabet");
assert.equal(profile.rosterPresetId("user.Legal-Helper"), "user-legal-helper", "dots and case fold together");
assert.match(profile.rosterPresetId("A_b.C-D"), /^[a-z0-9][a-z0-9-]*$/, "the fold always lands inside the plugin's regex");
const wild = profile.writeCatalogAgentPresets([
  { id: "qnhd7B3J1-HKDDKzZQ_fUQ.doc-report-writer", type: "agent-remote", mode: "chat", name: "文档工坊", baseUrl: "https://x/v1", model: "m" },
]);
assert.deepEqual(wild.ids, ["qnhd7b3j1-hkddkzzq-fuq-doc-report-writer"], "a case-mixed/underscore catalog id becomes a mountable preset row");
// Restore the original catalog so the idempotence assertion below sees the
// same wanted set it left behind.
profile.writeCatalogAgentPresets(entries);

// Idempotent: the catalog is polled every minute, so a second pass must be free.
const second = profile.writeCatalogAgentPresets(entries);
assert.equal(second.changed, false, "an unchanged catalog rewrites nothing");

// A departed entry leaves the definitions and the known set.
profile.writeCatalogAgentPresets([]);
assert.ok(!profile.hasCatalogAgentPreset("pack-contract-reviewer"), "a departed entry's preset is pruned from the defs");
const known = profile.knownPresetIds();
assert.ok(known.has("standard"), "standard is always known");
assert.ok(!known.has("pack-contract-reviewer"), "a pruned preset leaves the known set");

fs.rmSync(home, { recursive: true, force: true });
console.log("catalog agent presets: all assertions passed");
