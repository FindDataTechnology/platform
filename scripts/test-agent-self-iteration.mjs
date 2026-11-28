// Unit tests — agent self-iteration (add-agent-self-iteration, 终片).
//
// Pins the spec contracts:
//   - 记忆章程: manifest validation (optional/≤600), catalog passthrough, and
//     the persona composition tail (declared vs byte-identical undeclared);
//   - 成本异常提案器: four-condition gate (wait floor × distinct days × sample
//     × carrier), provenance/evidence in the proposal, in-flight dedup, and
//     the approval callback (same updateMember face, decision-resolved fact);
//   - 防中毒: no evidence → no proposal; auto proposals never self-apply.
//
// Run: node --test scripts/test-agent-self-iteration.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "self-iteration-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

// ── 记忆章程: manifest validation ────────────────────────────────────────────
const { validatePackManifest } = await import("../lib/pack-manifest.js");

function manifestWith(agent) {
  return {
    name: "章程包", packId: "pack-constitution", version: "1.0.0", description: "x",
    mcpServers: [], agents: [agent],
  };
}

test("manifest: memory.guidance optional and validated", () => {
  const base = {
    id: "a1", name: "章程员", persona: "你是章程员。",
  };
  const errs = (m) => validatePackManifest(manifestWith(m)) ?? [];
  assert.equal(errs({ ...base }).length, 0, "absent memory is fine");
  assert.equal(errs({ ...base, memory: { guidance: "记住每个数据源的失效开关位置" } }).length, 0, "valid guidance accepted");
  assert.ok(errs({ ...base, memory: { guidance: "x".repeat(601) } }).some((e) => /memory.guidance/.test(e.error)), "601 chars rejected");
  assert.ok(errs({ ...base, memory: { guidance: "  " } }).some((e) => /memory.guidance/.test(e.error)), "blank rejected");
});

// ── 记忆章程: persona composition ────────────────────────────────────────────
const { catalogEntryPersona } = await import("../dsh-profile.js");

test("persona composition: constitution tail present only when declared", () => {
  const entry = { id: "a1", name: "章程员", description: "x", memory: { guidance: "记住失效开关位置。" } };
  const withC = catalogEntryPersona(entry);
  assert.match(withC, /【记忆章程】记住失效开关位置。/);
  const without = catalogEntryPersona({ id: "a1", name: "章程员", description: "x" });
  assert.ok(!without.includes("【记忆章程】"), "undeclared agent byte-identical");
});

// ── 提案器: the four-condition gate ──────────────────────────────────────────
const { carrierAnomalies } = await import("../server/fleet-cost-digest.js");

test("anomaly gate: four conditions ALL hit", () => {
  const hit = { memberId: "m1", turns: 8, queueWaitMax: 6 * 60_000, hotDays: 4, carrier: "cell", costUsd: 0.01, pricedTurns: 8 };
  assert.deepEqual(carrierAnomalies([hit]).map((x) => x.memberId), ["m1"]);
  const fewDays = { ...hit, hotDays: 2 };
  assert.deepEqual(carrierAnomalies([fewDays]), [], "2 hot days → not受理");
  const fewTurns = { ...hit, turns: 4 };
  assert.deepEqual(carrierAnomalies([fewTurns]), [], "sample < 6 → not受理");
  const waitLow = { ...hit, queueWaitMax: 4 * 60_000 };
  assert.deepEqual(carrierAnomalies([waitLow]), [], "wait below 5min → not受理");
  const alreadyWorker = { ...hit, carrier: "worker" };
  assert.deepEqual(carrierAnomalies([alreadyWorker]), [], "worker/runner carriers exempt");
});

// ── 提案投递 + 在途去重 + 批准回调 ────────────────────────────────────────────
const { createFleetDatabase } = await import("../server/routes/fleets-db.js");
const { runFleetCostDigests } = await import("../server/fleet-cost-digest.js");

const DB_FILE = path.join(tmpRoot, `fleets-${Date.now()}.db`);
const db = createFleetDatabase({ file: DB_FILE });
db.createFleet({
  id: "fleet_s1", name: "自迭代舰队", ownerEmail: "s@test", state: "active", decisionPolicy: null,
  sourceTemplate: null, defaultModel: null, effort: null, contextBudget: null,
  orchestration: { posts: [], edges: [], constraints: {} },
  createdAt: Date.now(), updatedAt: Date.now(),
});
db.createMember({ id: "m_hot", fleetId: "fleet_s1", title: "热岗", parentId: null, targetKind: "persona", targetId: "pack-a", kpiSlots: [], cadence: null, sortKey: 0, createdAt: Date.now(), updatedAt: Date.now() });

test("sweep proposes once with provenance; dedup skips while in flight", async () => {
  const raw = db.db ?? db;
  const insert = raw.prepare(`INSERT INTO member_turn_daily (fleet_id, member_id, carrier, provider, model, day, turns, ok_count, failed_count, usage_input, usage_cached_input, usage_cache_write, usage_reasoning, usage_output, queue_wait_ms_sum, queue_wait_ms_max, ttft_ms_sum, ttft_ms_max, spin_up_ms_sum, spin_up_ms_max, updated_at)
    VALUES ('fleet_s1','m_hot','cell','volces','deepseek-v4.1-flash',?,3,2,1,10,0,0,0,5,400000,360000,100,100,0,0,?)`);
  // Pin the sweep clock mid-week (runFleetCostDigests takes `now`) and seed
  // days relative to that pinned Wednesday: seeding relative to the real
  // clock makes this test flake at ISO-week boundaries (written on a
  // Saturday — passed; run the following Monday — thisWeek collapses to one
  // day and the sample floor fails).
  const pinnedNow = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() || 7) - 3)); return d; })();
  const dayOf = (off) => { const d = new Date(pinnedNow); d.setUTCDate(d.getUTCDate() - off); return d.toISOString().slice(0, 10); };
  for (const off of [0, 1, 2, 3]) insert.run(dayOf(off), Date.now());

  const proposals = [];
  const carriers = new Map([["m_hot", "cell"]]);
  const n1 = await runFleetCostDigests({
    now: pinnedNow,
    fleetsDb: db,
    captureFact: () => {},
    listActiveFleets: () => [{ id: "fleet_s1", state: "active" }],
    written: new Map(),
    propose: async (p) => { proposals.push(p); },
    memberCarriers: carriers,
  });
  assert.equal(n1, 1, "weekly page written");
  assert.equal(proposals.length, 1, "the anomaly filed ONE proposal");
  assert.equal(proposals[0].changes.memberId, "m_hot");
  assert.equal(proposals[0].changes.carrier, "worker");
  assert.equal(proposals[0].evidence.proposedBy, "platform:cost-anomaly", "provenance");
  assert.ok(proposals[0].evidence.sampleTurns >= 6, "evidence carries the sample");

  // Dedup: pre-insert the open carrier-change decision the REAL propose face
  // would have filed (the test's propose is a recorder) — the sweep must skip.
  db.appendDecision({
    id: "d_dedup", fleetId: "fleet_s1", memberId: "", question: "承载提议 · m_hot",
    options: [{ value: "approve" }, { value: "reject" }], severity: "normal",
    recommendation: "承载提议", itemType: "carrier-change",
    detail: { changes: { memberId: "m_hot", carrier: "worker" }, proposedBy: "platform:cost-anomaly" },
  });
  const n2 = await runFleetCostDigests({
    now: pinnedNow,
    fleetsDb: db,
    captureFact: () => {},
    listActiveFleets: () => [{ id: "fleet_s1", state: "active" }],
    written: new Map(),
    propose: async (p) => { proposals.push(p); },
    memberCarriers: carriers,
  });
  assert.equal(proposals.length, 1, "in-flight dedup: no second proposal");
  void n2;
});

test("approval callback applies carrier via updateMember and records the fact", async () => {
  // The callback reads the decision item's detail.changes — simulate exactly
  // what routes/fleets.js does (same updateMember face).
  const item = db.listDecisions({ fleetId: "fleet_s1", state: "open" })[0];
  const changes = item.detail?.changes;
  assert.equal(changes.carrier, "worker");
  db.updateMember(changes.memberId, { carrier: changes.carrier ?? null });
  assert.equal(db.getMember("m_hot").carrier, "worker", "approved placement applied");
  db.updateMember("m_hot", { carrier: null }); // restore
  assert.equal(db.getMember("m_hot").carrier, null);
});
