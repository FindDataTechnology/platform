#!/usr/bin/env node
// ── Persona compose-root tests (add-persona-resource-sets, task 3.1) ─────────
//
// buildPersonaSkillsRoot materializes the per-persona skills scope as a dir
// of relative symlinks under packs/<packId>/personas/<agentId>/ (design D3):
// built iff the persona declares a non-empty skills list, rebuilt idempotently
// from the durable rows (never edited in place), links only what the pack
// actually owns here (a foreign-collision name silently narrows), and removed
// wholesale with the pack root on uninstall. rebuildFromDb must not mistake
// the reserved personas/ subtree for a stale skill dir.
//
//   node --test scripts/test-persona-compose-roots.mjs

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "persona-roots-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");

const db = await import("../db.js");
await db.initDb();
const packStore = await import("../pack-store.js");
const sm = await import("../skill-materialize.js");

const PACK_ID = "persona-roots-pack";
const AGENT_ID = "persona-roots-agent";
const packRoot = sm.packSkillsRoot(PACK_ID);
const personaRoot = sm.personaSkillsRoot(PACK_ID, AGENT_ID);

// A user skill the pack's third skill will collide with at install.
db.addCustomSkill({ name: "collided-skill", description: "user's own", content: "user" });

const manifest = {
  name: "组合根测试包",
  skills: [
    { name: "declared-a", description: "d", content: "# a" },
    { name: "declared-b", description: "d", content: "# b" },
    { name: "undeclared-c", description: "d", content: "# c" },
    { name: "collided-skill", description: "d", content: "# pack's version" },
  ],
  mcpServers: [],
  agents: [
    {
      id: AGENT_ID,
      name: "组合根官",
      persona: "你是组合根官。",
      resources: { skills: ["declared-a", "declared-b", "collided-skill"] },
    },
  ],
};

const hooks = {};
await packStore.installPack({ packId: PACK_ID, version: 1, manifest, user: null, hooks });

const ownedRows = () => db.listCustomSkills().filter((s) => s.originPackId === PACK_ID);
const declared = () => manifest.agents[0].resources.skills;

test.after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

test("persona root links only declared AND owned skills, via relative symlinks", () => {
  const root = sm.buildPersonaSkillsRoot(PACK_ID, AGENT_ID, declared(), ownedRows());
  assert.equal(root, personaRoot);
  // collided-skill was skipped at install (foreign owner) — silently narrows.
  assert.deepEqual(readdirSync(personaRoot).sort(), ["declared-a", "declared-b"]);
  assert.equal(readlinkSync(path.join(personaRoot, "declared-a")), path.join("..", "..", "declared-a"));
  assert.equal(readlinkSync(path.join(personaRoot, "declared-b")), path.join("..", "..", "declared-b"));
  // The undeclared skill stays only in the pack root.
  assert.ok(existsSync(path.join(packRoot, "undeclared-c")));
});

test("rebuilding twice yields an identical tree (idempotent, no churn)", () => {
  const snapshot = () =>
    readdirSync(personaRoot)
      .sort()
      .map((n) => [n, readlinkSync(path.join(personaRoot, n))]);
  const before = snapshot();
  // A second build over an EXISTING root must produce the same links; a stale
  // foreign dir inside the root is wiped.
  mkdirSync(path.join(personaRoot, "stale-junk"), { recursive: true });
  symlinkSync("../nowhere", path.join(personaRoot, "dangling"), "dir");
  sm.buildPersonaSkillsRoot(PACK_ID, AGENT_ID, declared(), ownedRows());
  assert.deepEqual(snapshot(), before);
});

test("absent or empty declaration yields no root (a stale one is removed)", () => {
  assert.equal(sm.buildPersonaSkillsRoot(PACK_ID, AGENT_ID, [], ownedRows()), null);
  assert.ok(!existsSync(personaRoot), "an empty declaration removes the stale root");
  assert.equal(sm.buildPersonaSkillsRoot(PACK_ID, AGENT_ID, undefined, ownedRows()), null);
  // Rebuild for the next assertions.
  sm.buildPersonaSkillsRoot(PACK_ID, AGENT_ID, declared(), ownedRows());
  assert.ok(existsSync(personaRoot));
});

test("rebuildFromDb preserves the reserved personas subtree", () => {
  sm.rebuildFromDb(db.listCustomSkills);
  assert.ok(existsSync(personaRoot), "rebuildFromDb must not prune personas/");
  assert.deepEqual(readdirSync(personaRoot).sort(), ["declared-a", "declared-b"]);
});

test("uninstalling the pack removes personas/ wholesale with the pack root", () => {
  packStore.uninstallPack({ packId: PACK_ID, force: true, hooks });
  assert.ok(!existsSync(packRoot), "the pack root is gone");
  assert.ok(!existsSync(personaRoot), "the persona root went with it");
  // And a rebuild attempt over the empty ownership returns no root.
  assert.equal(sm.buildPersonaSkillsRoot(PACK_ID, AGENT_ID, declared(), ownedRows()), null);
});
