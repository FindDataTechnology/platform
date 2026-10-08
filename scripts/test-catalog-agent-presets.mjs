// Self-check for the catalog-agent persona presets (dsh-profile.js).
//
// A vertical-pack agent is served LOCALLY: the deployment composes one agent
// preset per chat-mode catalog entry from the shipped `standard` composition,
// swapping only the persona row. That is what keeps the pack chat on the local
// runtime — its tools, MCP servers, skills and session history — instead of
// forking to a bare remote model. The branches worth breaking: persona swap
// tearing the composition, idempotence (the catalog is polled every minute),
// pruning a departed entry, and never touching a preset we did not generate.
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

// A synthetic "shipped" composition: the persona row plus the two shapes the
// text-level swap must not disturb (a `!!js` tag, a following row, a nested
// group whose body is deeper than the persona's).
const SHIPPED = `# standard composition (fixture)
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'

- id: planning
  name: cordis:group
  group: true
  config:
    - id: plan-mode
      name: '@deepseek-ai/dsh-plan-mode'
`;
const shippedDir = path.join(home, "profiles", "node_modules", "@deepseek-ai", "dsh", "config", "agent-presets");
fs.mkdirSync(path.join(shippedDir, "standard"), { recursive: true });
fs.writeFileSync(path.join(shippedDir, "standard", "agent.cordis.yml"), SHIPPED);
fs.mkdirSync(path.join(shippedDir, "minimal"), { recursive: true });
fs.writeFileSync(path.join(shippedDir, "minimal", "agent.cordis.yml"), SHIPPED);

const profile = await import("../dsh-profile.js");
const presetDir = (id) => path.join(home, ".agent-presets", id);

// ── persona text ─────────────────────────────────────────────────────────────
const explicit = profile.catalogEntryPersona({ id: "pack-a", name: "A", description: "d", persona: "  你是 A。  " });
assert.ok(explicit.startsWith("你是 A。"), "an explicit persona is used verbatim");
assert.ok(explicit.includes("{{model}}"), "the runner line stays for the plugin to resolve");

const composed = profile.catalogEntryPersona({ id: "pack-a", name: "合同审查官", description: "法律-合同包对话入口", tags: ["法律", "合同"] });
assert.ok(composed.includes("合同审查官") && composed.includes("法律-合同包对话入口"), "name + description seed the persona");
assert.ok(composed.includes("不要凭记忆编造"), "the honesty rule is part of the generated persona");

// ── composition swap ─────────────────────────────────────────────────────────
const swapped = profile.composeAgentPreset(SHIPPED, "PROBE 你是合同审查官。");
assert.ok(swapped.includes('text: "PROBE 你是合同审查官。"'), "persona row carries the new text");
assert.ok(!swapped.includes("You are a coding agent"), "the shipped persona line is gone");
assert.ok(swapped.includes("dsh-tool-bash") && swapped.includes("!!js process.platform"), "tool rows and yaml tags survive");
assert.ok(swapped.includes("plan-mode") && swapped.includes("      name: '@deepseek-ai/dsh-plan-mode'"), "a nested group body is untouched");
assert.equal(profile.composeAgentPreset(SHIPPED, "x").split("- id: persona").length - 1, 1, "exactly one persona row");
assert.throws(() => profile.composeAgentPreset("- id: other\n", "x"), /persona/, "a composition without the row fails loudly");

// ── generation ───────────────────────────────────────────────────────────────
const entries = [
  { id: "pack-contract-reviewer", type: "agent-remote", mode: "chat", name: "合同审查官", description: "法律-合同包对话入口", baseUrl: "https://x/v1", model: "m" },
  { id: "pack-link", type: "agent-remote", mode: "link", name: "Link", url: "https://example.com" },
  { id: "standard", type: "agent-remote", mode: "chat", name: "Shadow", description: "may not shadow a shipped preset", baseUrl: "https://x/v1", model: "m" },
];
const first = profile.writeCatalogAgentPresets(entries);
assert.deepEqual(first.ids, ["pack-contract-reviewer"], "only chat-mode entries with a free id become presets");
assert.equal(first.changed, true, "first generation reports a change");
assert.ok(fs.existsSync(path.join(presetDir("pack-contract-reviewer"), "agent.cordis.yml")), "composition written");
assert.ok(fs.existsSync(path.join(presetDir("pack-contract-reviewer"), ".platform-catalog-preset.json")), "generated dirs are marked");
assert.ok(!fs.existsSync(presetDir("standard")), "a shipped preset id is never shadowed");
assert.ok(profile.hasCatalogAgentPreset("pack-contract-reviewer"), "the id resolves to a local preset");
assert.ok(!profile.hasCatalogAgentPreset("pack-link"), "a link entry has no preset");

const presetYml = fs.readFileSync(path.join(presetDir("pack-contract-reviewer"), "preset.yml"), "utf8");
assert.ok(presetYml.includes("合同审查官"), "preset.yml carries the display name (the picker's label)");

// Idempotent: the catalog is polled every minute, so a second pass must be free.
const second = profile.writeCatalogAgentPresets(entries);
assert.equal(second.changed, false, "an unchanged catalog rewrites nothing");

// A hand-authored preset under the same root is left alone.
const mine = path.join(home, ".agent-presets", "my-own");
fs.mkdirSync(mine, { recursive: true });
fs.writeFileSync(path.join(mine, "agent.cordis.yml"), "hand-authored\n");
profile.writeCatalogAgentPresets([]);
assert.ok(fs.existsSync(path.join(mine, "agent.cordis.yml")), "unmarked dirs are not pruned");
assert.ok(!fs.existsSync(presetDir("pack-contract-reviewer")), "a departed catalog entry is pruned");

// knownPresetIds: the shipped set plus whatever the user root holds.
const known = profile.knownPresetIds();
assert.ok(known.has("standard") && known.has("minimal") && known.has("my-own"), "shipped + user presets are known");
assert.ok(!known.has("pack-contract-reviewer"), "a pruned preset leaves the known set");

fs.rmSync(home, { recursive: true, force: true });
console.log("catalog agent presets: all assertions passed");
