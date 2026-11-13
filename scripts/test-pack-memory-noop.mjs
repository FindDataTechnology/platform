// add-pack-memory-declaration task 5.1: proving the wiring is INERT for packs
// that do not declare memory.
//
// The claim under test is "byte-identical behaviour for existing packs". A test
// that only asserts today's output is green says nothing about whether it changed
// — the expectation would be whatever the new code happens to produce. So this
// runs the REAL pre-wiring validator (rebuilt from git at the commit that
// introduced the wiring) beside the current one, on the same manifests, and
// requires identical error output.
//
// Scope note: the baseline commit predates a sibling change's console/plugins
// wiring too, so those sections are excluded — this test says "my change altered
// nothing for packs that don't declare memory", not "nothing at all changed".
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePackManifest } from "../lib/pack-manifest.js";

const PAAS = join(dirname(fileURLToPath(import.meta.url)), "..");

function git(args) {
  return execFileSync("git", args, { cwd: PAAS, encoding: "utf8" }).trim();
}

// The baseline is the PARENT of the commit that introduced the wiring, which only
// names the pre-change code in a history of real commits. The public repo's main
// is a squashed export (one commit per release), so `git archive <hit>^` dies with
// "not a valid object name" there — a red that says nothing about the wiring.
// Measured 2026-11-13 on the published snapshot: depth 1. Every test below needs
// this, so it is one named question, not four copies of a magic number.
const HISTORY_DEPTH = Number(git(["rev-list", "--count", "HEAD"]));
function hasPreChangeBaseline(t) {
  if (HISTORY_DEPTH >= 10) return true;
  t.skip(`squashed history (${HISTORY_DEPTH} commits) — no pre-change baseline to compare against`);
  return false;
}

/** Rebuild the validator as it stood before the memory wiring existed. */
function baselineValidator() {
  const introducedBy = git(["log", "-S", "validateMemoryBlock", "--format=%H", "--", "lib/pack-manifest.js"])
    .split("\n")
    .filter(Boolean)
    .at(-1);
  assert.ok(introducedBy, "could not find the commit that introduced the memory wiring");
  const dir = mkdtempSync(join(tmpdir(), "pm-baseline-"));
  const archive = execFileSync("git", ["archive", `${introducedBy}^`, "lib"], { cwd: PAAS, maxBuffer: 64 * 1024 * 1024 });
  // tar unpacks a git archive; one tar process, no shell.
  const untar = spawnSync("tar", ["-x", "-C", dir], { input: archive });
  assert.equal(untar.status, 0, `tar failed: ${untar.stderr}`);
  return { dir, module: join(dir, "lib", "pack-manifest.js") };
}

// Errors carry a message string; compare code+path+message so a reworded message
// counts as a difference (it would surface in the publish UI).
const shape = (errors) =>
  errors
    .map((e) => ({ path: e.path ?? null, code: e.code ?? null, error: e.error }))
    .sort((a, b) => `${a.path}|${a.code}`.localeCompare(`${b.path}|${b.code}`));

const SKILL = { name: "s1", description: "技能", content: "正文" };

// Manifests covering every section that existed BEFORE both changes, so a
// difference can only come from the memory wiring.
const MANIFESTS = {
  "minimal pack": { name: "p", description: "d", skills: [SKILL] },
  "tags + category + visibility": {
    name: "p",
    description: "d",
    tags: ["a", "b"],
    category: "legal",
    visibility: "private",
    skills: [SKILL],
  },
  "notes over the cap": { name: "p", description: "d", notes: "x".repeat(600), skills: [SKILL] },
  "agent with persona": {
    name: "p",
    description: "d",
    agents: [{ id: "a1", name: "角色", persona: "人设" }],
  },
  "agent with guidance only": {
    name: "p",
    description: "d",
    agents: [{ id: "a1", name: "角色", persona: "人设", memory: { guidance: "记口径" } }],
  },
  "agent with bad guidance": {
    name: "p",
    description: "d",
    agents: [{ id: "a1", name: "角色", persona: "人设", memory: { guidance: "" } }],
  },
  "agent with legacy memory_scope": {
    name: "p",
    description: "d",
    agents: [{ id: "a1", name: "角色", persona: "人设", memory_scope: "private" }],
  },
  "agent with resources": {
    name: "p",
    description: "d",
    skills: [SKILL],
    agents: [{ id: "a1", name: "角色", persona: "人设", resources: { skills: ["s1"] } }],
  },
  "agent referencing a foreign skill": {
    name: "p",
    description: "d",
    skills: [SKILL],
    agents: [{ id: "a1", name: "角色", persona: "人设", resources: { skills: ["nope"] } }],
  },
  "duplicate agent id": {
    name: "p",
    description: "d",
    agents: [
      { id: "a1", name: "A", persona: "p" },
      { id: "a1", name: "B", persona: "p" },
    ],
  },
  "mcp reference": {
    name: "p",
    description: "d",
    mcpServers: [{ registryName: "fd-open-data-mcp", allowTools: ["read"] }],
  },
  "empty pack": { name: "p", description: "d" },
  "missing name": { description: "d", skills: [SKILL] },
  "banned vocabulary in description": { name: "p", description: "接入全部数据，替代所有人工", skills: [SKILL] },
  "guide with three steps": {
    name: "p",
    description: "d",
    skills: [SKILL],
    guide: { steps: [{ title: "a", body: "b" }, { title: "c", body: "d" }, { title: "e", body: "f" }] },
  },
};

test("every pre-existing manifest validates identically before and after the wiring", async (t) => {
  if (!hasPreChangeBaseline(t)) return;
  const baseline = baselineValidator();
  try {
    const old = await import(baseline.module);
    const differences = [];
    for (const [label, manifest] of Object.entries(MANIFESTS)) {
      const before = shape(old.validatePackManifest(structuredClone(manifest)));
      const after = shape(validatePackManifest(structuredClone(manifest)));
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        differences.push(`${label}\n  before: ${JSON.stringify(before)}\n  after:  ${JSON.stringify(after)}`);
      }
    }
    assert.deepEqual(differences, [], `the memory wiring changed behaviour for manifests without memory:\n${differences.join("\n")}`);
  } finally {
    rmSync(baseline.dir, { recursive: true, force: true });
  }
});

test("the battery actually exercises errors (a battery of clean packs proves nothing)", async (t) => {
  if (!hasPreChangeBaseline(t)) return;
  const baseline = baselineValidator();
  try {
    const old = await import(baseline.module);
    const withErrors = Object.entries(MANIFESTS).filter(
      ([, m]) => old.validatePackManifest(structuredClone(m)).length > 0,
    );
    assert.ok(
      withErrors.length >= 4,
      `expected several manifests to produce errors, got ${withErrors.length}: ${withErrors.map(([k]) => k).join(", ")}`,
    );
  } finally {
    rmSync(baseline.dir, { recursive: true, force: true });
  }
});

test("declaring memory ADDS findings and removes none", async (t) => {
  if (!hasPreChangeBaseline(t)) return;
  const baseline = baselineValidator();
  try {
    const old = await import(baseline.module);
    const base = { name: "p", description: "d", skills: [SKILL] };
    const declared = {
      ...base,
      memory: { store: { home: "d/pack/member" }, read: { scope: "own" }, process: { distil: "off" } },
    };
    const before = shape(old.validatePackManifest(structuredClone(declared)));
    const after = shape(validatePackManifest(structuredClone(declared)));
    // Baseline ignored the unknown top-level key entirely.
    assert.equal(before.length, 0, `baseline unexpectedly produced findings: ${JSON.stringify(before)}`);
    assert.deepEqual(
      after.map((e) => e.code).sort(),
      ["memory_key_unknown", "read_scope_unexecutable", "store_home_addressed"],
      "the address, the unexecutable scope and the misspelled process key must all be named",
    );
  } finally {
    rmSync(baseline.dir, { recursive: true, force: true });
  }
});

// ── the one intentional behaviour change, stated rather than hidden ────────

test("an invalid legacy memory_scope is now refused, and that is deliberate", async (t) => {
  if (!hasPreChangeBaseline(t)) return;
  // Measured difference, so it is documented instead of quietly absorbed:
  // `agents[].memory_scope` had NO consumer in this repo — a bogus value was dead
  // data that published fine. The change makes it a validated spelling of
  // write.authority, so a pack carrying `memory_scope: "team"` now fails instead
  // of passing with a field nothing reads.
  //
  // Why accept the tightening: the alternative is a declaration that cannot take
  // effect anywhere, which is the defect this change set removes. The error names
  // the field, so an author fixes it in one edit.
  const baseline = baselineValidator();
  try {
    const old = await import(baseline.module);
    const manifest = {
      name: "p",
      description: "d",
      agents: [{ id: "a1", name: "角色", persona: "人设", memory_scope: "team" }],
    };
    assert.deepEqual(old.validatePackManifest(structuredClone(manifest)), [], "baseline ignored it");
    const now = validatePackManifest(structuredClone(manifest));
    assert.deepEqual(now.map((e) => e.code), ["memory_scope_invalid"]);
    assert.match(now[0].error, /private, shared/);
  } finally {
    rmSync(baseline.dir, { recursive: true, force: true });
  }
});
