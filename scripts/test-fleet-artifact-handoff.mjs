// Upstream artifact handles across an edge (add-fleet-artifact-handoff).
//
// A handoff used to relay prose only: the successor read a 2000-char summary and
// regenerated the chart/doc/sheet the upstream had already produced — paying
// twice, often landing somewhere different. The platform captures turn-produced
// files into the resource library, so the handles existed; they just never
// crossed the edge.
//
// Run: node --test scripts/test-fleet-artifact-handoff.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-handoff-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const db = await import("../db.js");
await db.initDb();
const engine = await import("../task-engine.js");
await engine.initTaskEngine({ broadcast: () => {}, runTurn: async () => ({ ok: true, text: "ok" }), isBusy: () => false });
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { igniteFleetEdges } = await import("../server/fleet-handoffs.js");
const resources = await import("../resources.js");

const fleetDb = createFleetDatabase({ file: path.join(tmpRoot, "fleets.db") });
setFleetDatabase(fleetDb);

const fleet = fleetDb.createFleet({ id: "f_art", name: "产物舰", ownerEmail: "owner@test" });
for (const [id, kind] of [["a_up", "persona"], ["a_down", "persona"], ["a_remote", "a2a"], ["a_fan", "persona"]]) {
  fleetDb.createMember({ id, fleetId: fleet.id, title: id, targetKind: kind, targetId: `t-${id}`, kpiSlots: [], cadence: null });
}

const seedArtifact = (sessionId, title, filePath, createdAt) =>
  db.insertResource({
    id: `res_${Math.random().toString(36).slice(2, 10)}`,
    type: "file",
    title,
    source: "auto",
    sessionId,
    sessionTitle: null,
    messageId: 1,
    payload: null,
    filePath,
    fileSize: 12,
    fileMime: "text/csv",
    contentHash: `h_${Math.random().toString(36).slice(2, 12)}`,
    createdAt,
    updatedAt: createdAt,
  });

test("reader: returns this session's artifacts, newest first, bounded by the window", async () => {
  const now = Date.now();
  seedArtifact("sess_a", "上周销售.csv", "out/sales.csv", new Date(now - 3_600_000).toISOString());
  seedArtifact("sess_a", "本周销售.csv", "out/sales2.csv", new Date(now).toISOString());
  seedArtifact("sess_other", "别人的.csv", "out/other.csv", new Date(now).toISOString());

  const all = await resources.artifactsForSession({ sessionId: "sess_a" });
  assert.equal(all.length, 2, "only this session's rows");
  assert.equal(all[0].title, "本周销售.csv", "newest first");
  assert.equal(all[0].filePath, "out/sales2.csv", "the workspace handle rides along");
  assert.ok(all[0].id.startsWith("res_"), "the library id is the stable handle");

  const recent = await resources.artifactsForSession({ sessionId: "sess_a", sinceMs: now - 60_000 });
  assert.equal(recent.length, 1, "the turn window trims history");

  assert.deepEqual(await resources.artifactsForSession({ sessionId: "nobody" }), []);
  assert.deepEqual(await resources.artifactsForSession({ sessionId: "" }), [], "no session ⇒ no read");
});

test("edge: a persona successor is handed the upstream's handles; prose still leads", async () => {
  fleetDb.updateFleet(fleet.id, { orchestration: { edges: [{ kind: "handoff", from: "a_up", to: "a_down" }], constraints: { maxChainDepth: 3 } } });
  const startedAt = Date.now() - 1000;
  seedArtifact("sess_up", "季度图表.json", "out/q3-chart.json", new Date(Date.now()).toISOString());

  const created = await igniteFleetEdges({
    db: fleetDb,
    engine,
    job: { id: "j_art", sessionId: "sess_up", preset: "roster:t-a_up", origin: { fleet: { fleetId: fleet.id, memberId: "a_up", depth: 0 } } },
    ledgerTurn: { turnId: "turn_art_1", runId: "run_art", startedAt },
    out: { ok: true, text: "已生成季度图表" },
  });
  assert.equal(created.length, 1);
  const prompt = engine.getTaskRecord(created[0].taskId).prompt;
  assert.match(prompt, /【上游产物】/, "the handles section is present");
  assert.match(prompt, /季度图表\.json/);
  assert.match(prompt, /workspace: out\/q3-chart\.json/, "the workspace path is named");
  assert.match(prompt, /资源库 res_/, "the library id is named");
  assert.match(prompt, /不要重新生成/, "the instruction is explicit");
  assert.ok(prompt.indexOf("上游结果") < prompt.indexOf("【上游产物】"), "prose leads, handles follow");
  assert.match(prompt, /\{\{fleetEdgeContext\}\}$/, "the edge-context token still ends the prompt");
});

test("edge: an a2a successor gets prose only — a library id means nothing to another service", async () => {
  fleetDb.updateFleet(fleet.id, { orchestration: { edges: [{ kind: "handoff", from: "a_up", to: "a_remote" }], constraints: { maxChainDepth: 3 } } });
  const created = await igniteFleetEdges({
    db: fleetDb,
    engine,
    job: { id: "j_art2", sessionId: "sess_up", preset: "roster:t-a_up", origin: { fleet: { fleetId: fleet.id, memberId: "a_up", depth: 0 } } },
    ledgerTurn: { turnId: "turn_art_2", runId: "run_art", startedAt: Date.now() - 1000 },
    out: { ok: true, text: "已生成季度图表" },
  });
  const prompt = engine.getTaskRecord(created[0].taskId).prompt;
  assert.doesNotMatch(prompt, /【上游产物】/);
});

test("edge: no artifacts (or an unreadable library) leaves the prompt exactly as before", async () => {
  fleetDb.updateFleet(fleet.id, { orchestration: { edges: [{ kind: "handoff", from: "a_up", to: "a_fan" }], constraints: { maxChainDepth: 3 } } });
  const created = await igniteFleetEdges({
    db: fleetDb,
    engine,
    job: { id: "j_art3", sessionId: "sess_empty", preset: "roster:t-a_up", origin: { fleet: { fleetId: fleet.id, memberId: "a_up", depth: 0 } } },
    ledgerTurn: { turnId: "turn_art_3", runId: "run_art", startedAt: Date.now() - 1000 },
    out: { ok: true, text: "没产出文件" },
  });
  const prompt = engine.getTaskRecord(created[0].taskId).prompt;
  assert.doesNotMatch(prompt, /【上游产物】/);
  assert.match(prompt, /上游结果:\n没产出文件/, "the prose relay is untouched");
});

test("edge: a fanout wave carries the same handles to each persona target", async () => {
  fleetDb.updateFleet(fleet.id, {
    orchestration: {
      edges: [{ kind: "fanout", from: "a_up", targets: ["a_down", "a_fan"], aggregate: { kind: "all" } }],
      constraints: { maxChainDepth: 3 },
    },
  });
  const created = await igniteFleetEdges({
    db: fleetDb,
    engine,
    job: { id: "j_art4", sessionId: "sess_up", preset: "roster:t-a_up", origin: { fleet: { fleetId: fleet.id, memberId: "a_up", depth: 0 } } },
    ledgerTurn: { turnId: "turn_art_4", runId: "run_art", startedAt: Date.now() - 1000 },
    out: { ok: true, text: "产出两份材料" },
  });
  assert.equal(created.length, 2);
  for (const { taskId } of created) {
    assert.match(engine.getTaskRecord(taskId).prompt, /【上游产物】/);
  }
});

test.after(async () => {
  await engine.idle?.();
  try { fleetDb.close(); } catch { /* shared handle */ }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});
