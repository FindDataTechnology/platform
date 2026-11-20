#!/usr/bin/env node
// ── Pack agent id ownership = materialization truth (真机回归 2026-11-01) ────
//
// agentOwner used to treat any OTHER installed pack's manifest DECLARATION as
// ownership — even when that pack's own install had SKIPPED the id. Two packs
// that each skip against the other's declaration deadlock the id out of the
// catalog: neither report says "installed", packAgentDoc materializes nothing,
// and every fleet member targeting the preset reads vacant "target object no
// longer exists" forever (生产实锤：走查钉库试跑 ↔ 乙班 互指 skipped，
// walkthrough-reader 消失，试跑连环红). The owner was ALSO stealable on
// upgrade: the original materializer's own re-install lost its id to a later
// bare claimant.
//
// Pins (ownership now requires the rival's report to say "installed"):
//   1. first install materializes; rival skips against a MATERIALIZED owner
//   2. owner upgrade keeps its own id (the steal regression)
//   3. two cross-pointing skipped rows self-heal on re-install
//   4. custom presets still own their ids against packs (D6 unchanged)
//   5. after the owner uninstalls, a rival re-install takes the id over
//   6. double materialization stays impossible
//
//   node --test scripts/test-pack-agent-ownership.mjs

import assert from "node:assert/strict";
import { mkdtempSync, } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "pack-agent-own-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");

const db = await import("../db.js");
await db.initDb();
const packStore = await import("../pack-store.js");

const BASE = {
  name: "岗包",
  description: "d",
  category: "fleet",
  skills: [{ name: "s1", description: "x", content: "y" }],
  agents: [{ id: "walkthrough-reader", name: "走查读库岗", description: "读库并回答", persona: "你是走查读库岗。" }],
};
const manifestFor = (over = {}) => JSON.parse(JSON.stringify({ ...BASE, ...over }));

test("1. first install materializes; rival skips against the MATERIALIZED owner", async () => {
  try {
    const a = await packStore.installPack({ packId: "pk-a", version: 1, manifest: manifestFor(), user: { email: "u@x" } });
    assert.equal(a.report.agents[0].status, "installed");
    const b = await packStore.installPack({ packId: "pk-b", version: 1, manifest: manifestFor({ name: "岗包乙" }), user: { email: "u@x" } });
    assert.equal(b.report.agents[0].status, "skipped");
    assert.match(b.report.agents[0].reason, /pk|岗包/);
  } finally {
    try { packStore.uninstallPack({ packId: "pk-b" }); } catch {}
    // pk-a stays: test 2 upgrades it in place.
  }
});

test("2. owner upgrade keeps its own id (the steal regression)", async () => {
  try {
    // pk-a owns the materialized id; pk-b's bare claim (skipped) must NOT block
    // pk-a's own upgrade — pre-fix, this re-install came back "skipped" pointing
    // at pk-b and the id vanished from the catalog.
    const up = await packStore.installPack({ packId: "pk-a", version: 2, manifest: manifestFor(), user: { email: "u@x" } });
    assert.equal(up.report.agents[0].status, "installed", "the original materializer must re-materialize on upgrade");
  } finally {
    try { packStore.uninstallPack({ packId: "pk-a" }); } catch {}
  }
});

test("3. two cross-pointing skipped rows self-heal on re-install", async () => {
  // Reproduce the production deadlock by hand: both rows claim via manifest,
  // both reports say skipped (each pointing at the other). The next install of
  // either pack finds NO materialized rival → materializes → the deadlock
  // breaks without any data surgery.
  const poisonedA = await packStore.installPack({ packId: "pk-c", version: 1, manifest: manifestFor({ name: "岗包丙" }), user: { email: "u@x" } });
  assert.equal(poisonedA.report.agents[0].status, "installed");
  await packStore.uninstallPack({ packId: "pk-c", user: { email: "u@x" } });
  // Hand-poison: pk-d row with a skipped report, manifest still declaring.
  const raw = db.getDb();
  raw.prepare(
    "INSERT INTO installed_packs (pack_id, name, version, manifest, report, installed_at, updated_at, source) VALUES (?,?,?,?,?,?,?,?)",
  ).run("pk-d", "岗包丁", 1, JSON.stringify(manifestFor({ name: "岗包丁" })), JSON.stringify({ agents: [{ id: "walkthrough-reader", status: "skipped", reason: "agent id is owned by installed pack 岗包丙" }] }), Date.now(), Date.now(), "market");
  const heal = await packStore.installPack({ packId: "pk-e", version: 1, manifest: manifestFor({ name: "岗包戊" }), user: { email: "u@x" } });
  try {
    assert.equal(heal.report.agents[0].status, "installed", "a rival's skipped claim must not block materialization");
  } finally {
    try { packStore.uninstallPack({ packId: "pk-e" }); } catch {}
    try { packStore.uninstallPack({ packId: "pk-d" }); } catch {}
  }
});

test("4. custom presets still own their ids against packs (D6 unchanged)", async () => {
  // agentOwner looks custom presets up BY ROW ID == agent id; the CRUD route
  // generates ids, so seed the colliding row directly.
  const raw = db.getDb();
  raw.prepare(
    "INSERT INTO user_presets (id, name, persona, skills, mcp_servers, tags, created_at, updated_at) VALUES ('walkthrough-reader','自定义同名岗','自定义','[]','[]','[]',?,?)",
  ).run(new Date().toISOString(), new Date().toISOString());
  try {
    const r = await packStore.installPack({ packId: "pk-f", version: 1, manifest: manifestFor({ name: "岗包己" }), user: { email: "u@x" } });
    assert.equal(r.report.agents[0].status, "skipped");
    assert.match(r.report.agents[0].reason, /自定义同名岗/);
  } finally {
    raw.prepare("DELETE FROM user_presets WHERE id = 'walkthrough-reader'").run();
    try { packStore.uninstallPack({ packId: "pk-f" }); } catch {}
  }
});

test("5. after the owner uninstalls, a rival re-install takes the id over", async () => {
  try {
    const own = await packStore.installPack({ packId: "pk-g", version: 1, manifest: manifestFor({ name: "岗包庚" }), user: { email: "u@x" } });
    assert.equal(own.report.agents[0].status, "installed");
    const rival = await packStore.installPack({ packId: "pk-h", version: 1, manifest: manifestFor({ name: "岗包辛" }), user: { email: "u@x" } });
    assert.equal(rival.report.agents[0].status, "skipped");
    try { packStore.uninstallPack({ packId: "pk-g" }); } catch {}
    const takeOver = await packStore.installPack({ packId: "pk-h", version: 2, manifest: manifestFor({ name: "岗包辛" }), user: { email: "u@x" } });
    assert.equal(takeOver.report.agents[0].status, "installed", "the id frees up when the materializing owner leaves");
  } finally {
    try { packStore.uninstallPack({ packId: "pk-h" }); } catch {}
  }
});

test("6. double materialization stays impossible", async () => {
  try {
    const x = await packStore.installPack({ packId: "pk-x", version: 1, manifest: manifestFor({ name: "岗包X" }), user: { email: "u@x" } });
    const y = await packStore.installPack({ packId: "pk-y", version: 1, manifest: manifestFor({ name: "岗包Y" }), user: { email: "u@x" } });
    const statuses = [x.report.agents[0].status, y.report.agents[0].status];
    assert.equal(statuses.filter((s) => s === "installed").length, 1, "exactly one pack materializes the id");
  } finally {
    try { packStore.uninstallPack({ packId: "pk-x" }); } catch {}
    try { packStore.uninstallPack({ packId: "pk-y" }); } catch {}
  }
});
