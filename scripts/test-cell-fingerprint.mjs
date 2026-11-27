// Unit tests for the CELL-side fingerprint gathering (harden-agent-runtime-spine,
// runtime-fingerprint 3.2). Exercises the read/compute boundary: what the cell
// actually has on disk becomes the fingerprint, and every unreadable input is
// stated absent rather than invented.
//
// Run: node --test scripts/test-cell-fingerprint.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { fingerprintForCell, readSkillBodies, extractMcpServers } = await import("../lib/cell-fingerprint.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cell-fp-"));
const skillsRoot = path.join(tmp, "skills");
const mcpPatch = path.join(tmp, "mcp.patch.yml");

function writeSkills(entries) {
  fs.rmSync(skillsRoot, { recursive: true, force: true });
  for (const [name, body] of Object.entries(entries)) {
    fs.mkdirSync(path.join(skillsRoot, name), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, name, "SKILL.md"), body);
  }
}
const writeMcp = (servers) => {
  const rows = servers
    .map((s) => `  - id: mcp-${s.name}\n    name: "@deepseek-ai/dsh-mcp-client"\n    config:\n      serverName: ${s.name}\n      failOnStartupError: false\n      transport: streamable-http\n      url: ${s.url}`)
    .join("\n");
  fs.writeFileSync(mcpPatch, `---\n- insert:\n${rows}\n`);
};

before(() => {
  writeSkills({ alpha: "# Alpha\n\nA.\n", beta: "# Beta\n\nB.\n" });
  writeMcp([{ name: "fd-open-data", url: "https://mcp.example.com/open-data" }]);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("skills: read off disk, sorted, one body per directory", () => {
  const out = readSkillBodies(skillsRoot);
  assert.deepEqual(out.map((s) => s.name), ["alpha", "beta"]);
  assert.match(out[0].body, /# Alpha/);
  // An absent root is an empty list, never a throw.
  assert.deepEqual(readSkillBodies(path.join(tmp, "nope")), []);
});

test("mcp: {name,url} pairs are extracted; comments and blanks never make a phantom", () => {
  const rows = extractMcpServers(`# a comment\n- insert:\n  - id: x\n    config:\n      serverName: 'quoted-name'\n      url: "https://q.example"\n\n`);
  assert.deepEqual(rows, [{ name: "quoted-name", url: "https://q.example", toolFace: "" }]);
  assert.deepEqual(extractMcpServers(null), []);
  assert.deepEqual(extractMcpServers("garbage::not yaml"), []);
});

test("fingerprint: stable across two gathers of the same tree", () => {
  const sel = { model: "deepseek-v4-pro", provider: "volces", effort: "high" };
  const a = fingerprintForCell({ mcpPatchPath: mcpPatch, skillRoots: [skillsRoot], ...sel });
  const b = fingerprintForCell({ mcpPatchPath: mcpPatch, skillRoots: [skillsRoot], ...sel });
  assert.equal(a.bundle, b.bundle);
});

test("fingerprint: editing one skill body moves it, and names that skill", () => {
  const sel = { model: "m", provider: "p", effort: "e" };
  const a = fingerprintForCell({ mcpPatchPath: mcpPatch, skillRoots: [skillsRoot], ...sel });
  fs.writeFileSync(path.join(skillsRoot, "beta", "SKILL.md"), "# Beta\n\nB DIFFERENTLY.\n");
  const b = fingerprintForCell({ mcpPatchPath: mcpPatch, skillRoots: [skillsRoot], ...sel });
  assert.notEqual(a.bundle, b.bundle);
  const changed = a.parts.skills.filter((s, i) => s.sha !== b.parts.skills[i].sha).map((s) => s.name);
  assert.deepEqual(changed, ["beta"]);
  // restore
  fs.writeFileSync(path.join(skillsRoot, "beta", "SKILL.md"), "# Beta\n\nB.\n");
});

test("fingerprint: re-indenting the patch does NOT move it (behaviour, not bytes)", () => {
  const sel = { model: "m", provider: "p", effort: "e" };
  const a = fingerprintForCell({ mcpPatchPath: mcpPatch, skillRoots: [skillsRoot], ...sel });
  const original = fs.readFileSync(mcpPatch, "utf8");
  fs.writeFileSync(mcpPatch, original.replace(/\n/g, "\n\n").replace(/^ {2}/gm, "    "));
  const b = fingerprintForCell({ mcpPatchPath: mcpPatch, skillRoots: [skillsRoot], ...sel });
  assert.equal(b.bundle, a.bundle);
  fs.writeFileSync(mcpPatch, original);
});

test("fingerprint: an endpoint change moves it", () => {
  const sel = { model: "m", provider: "p", effort: "e" };
  const a = fingerprintForCell({ mcpPatchPath: mcpPatch, skillRoots: [skillsRoot], ...sel });
  const original = fs.readFileSync(mcpPatch, "utf8");
  writeMcp([{ name: "fd-open-data", url: "https://elsewhere.example.com" }]);
  const b = fingerprintForCell({ mcpPatchPath: mcpPatch, skillRoots: [skillsRoot], ...sel });
  assert.notEqual(a.bundle, b.bundle);
  fs.writeFileSync(mcpPatch, original);
});

test("fingerprint: absent inputs are stated absent, never guessed", async () => {
  const fp = fingerprintForCell({
    mcpPatchPath: path.join(tmp, "missing.yml"),
    skillRoots: [path.join(tmp, "missing-skills")],
    presetDefs: [],
    presetId: "p-1",
    model: null,
    provider: null,
    effort: null,
    matrixVersion: null,
  });
  assert.deepEqual(fp.parts.skills, []);
  assert.deepEqual(fp.parts.mcp, []);
  assert.equal(fp.parts.matrix, null);
  // An absent persona is the digest of the empty text — a STATUS, not a guess.
  const { createHash } = await import("node:crypto");
  assert.equal(fp.parts.persona, createHash("sha256").update("").digest("hex"));
  // And the bundle of "everything absent" is stable across gathers.
  const again = fingerprintForCell({ mcpPatchPath: path.join(tmp, "missing.yml"), skillRoots: [] });
  assert.equal(again.bundle, fp.bundle);
});

test("skills roots: read from the patch, absent file is an empty list", async () => {
  const { readSkillRootsFromPatch } = await import("../lib/cell-fingerprint.js");
  const p = path.join(tmp, "skills.patch.yml");
  fs.writeFileSync(p, `---\n- id: skill-filesystem\n  config:\n    customSkillDirs:\n      - /app/skills\n      - '/data/cells/abc/skills'\n`);
  assert.deepEqual(readSkillRootsFromPatch(p), ["/app/skills", "/data/cells/abc/skills"]);
  assert.deepEqual(readSkillRootsFromPatch(path.join(tmp, "nope.yml")), []);
});

test("fingerprint: roots named by the patch are used when the caller passes none", () => {
  const p = path.join(tmp, "skills.patch.yml");
  fs.writeFileSync(p, `---\n- id: skill-filesystem\n  config:\n    customSkillDirs:\n      - ${skillsRoot}\n`);
  const sel = { model: "m", provider: "p", effort: "e" };
  const viaPatch = fingerprintForCell({ mcpPatchPath: mcpPatch, skillsPatchPath: p, ...sel });
  const viaArg = fingerprintForCell({ mcpPatchPath: mcpPatch, skillRoots: [skillsRoot], ...sel });
  assert.equal(viaPatch.bundle, viaArg.bundle, "the file the child reads is the source of truth");
});
