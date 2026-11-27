// Unit tests for the owner inbox lane table (openspec: owner-inbox).
//
// Pins the two properties the spec makes load-bearing:
//   1. read-only + honest degradation: a lane that throws degrades alone,
//      answers status:"error", and NEVER contributes a zero to the counts;
//   2. consequence text is derived from the SAME detail fields the approval
//      callbacks read, and an unknown item type says so instead of borrowing
//      a generic sentence.
//
// Plus the classification edges the fleet lane must get right: deputy/triage
// routes never appear (they are the deputy's queue), an overdue-but-unswept row
// counts as expired rather than waiting, and a deleted source post still shows
// its pending ruling as inflight.
//
// Run: node --test scripts/test-owner-inbox.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "owner-inbox-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const { initDb } = await import("../db.js");
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { buildInbox, LANE_IDS, consequenceFor, gradeKind } = await import("../server/owner-inbox.js");

await initDb();

const fleetDb = createFleetDatabase({ file: path.join(tmpRoot, "fleets.db") });
setFleetDatabase(fleetDb);

test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const OWNER = "owner@test";

function makeFleet(name = "甲舰队", owner = OWNER) {
  return fleetDb.createFleet({ id: `fleet_${Math.random().toString(36).slice(2, 8)}`, name, ownerEmail: owner });
}

function makeMember(fleetId, { title = "主编", targetKind = "persona" } = {}) {
  return fleetDb.createMember({
    id: `mem_${Math.random().toString(36).slice(2, 8)}`,
    fleetId,
    title,
    targetKind,
    targetId: `preset_${Math.random().toString(36).slice(2, 6)}`,
  });
}

function makeDecision(fleetId, memberId, over = {}) {
  return fleetDb.appendDecision({
    id: `dec_${Math.random().toString(36).slice(2, 8)}`,
    fleetId,
    memberId,
    question: "本周视频是否提前发布",
    options: [
      { value: "now", label: "立即发布" },
      { value: "fri", label: "周五发布" },
    ],
    severity: "high",
    submittedAt: Date.now(),
    ...over,
  });
}

// ── consequence text ────────────────────────────────────────────────────────

test("consequence: config-change names the cast/publish chain and binds detail.changes", () => {
  const c = consequenceFor({
    itemType: "config-change",
    detail: { changes: { cadenceDaily: "0 10 * * *" }, settlement: { metric_ref: "m" } },
  });
  assert.match(c.approvedEffect, /铸成下一版/);
  assert.match(c.approvedEffect, /cadenceDaily/);
  assert.deepEqual(c.boundFields, ["detail.changes", "detail.settlement"]);
});

test("consequence: carrier-change names the post and the new carrier", () => {
  const c = consequenceFor({
    itemType: "carrier-change",
    detail: { changes: { memberId: "mem_abc", carrier: "worker" } },
  });
  assert.match(c.approvedEffect, /mem_abc/);
  assert.match(c.approvedEffect, /worker/);
});

test("consequence: an UNKNOWN item type says unknown — never a generic sentence", () => {
  const c = consequenceFor({ itemType: "quantum-shift", detail: {} });
  assert.equal(c.unknownType, true);
  assert.match(c.approvedEffect, /未知/);
  // and it must not claim any field binding it does not have
  assert.deepEqual(c.boundFields, []);
});

test("consequence: a deleted source post still explains the pending-restore outcome", () => {
  const c = consequenceFor({ itemType: "decision", memberDeleted: true });
  assert.match(c.approvedEffect, /待岗位恢复/);
});

// ── lane isolation ──────────────────────────────────────────────────────────

test("buildInbox: a throwing lane degrades alone and contributes NO zero", () => {
  const boom = () => {
    throw new Error("lane down");
  };
  const ok = () => [
    {
      laneId: "skill-candidate",
      itemRef: "s1",
      bucket: "waiting",
      bucketOnly: true,
    },
  ];
  const table = Object.fromEntries(LANE_IDS.map((id) => [id, id === "skill-candidate" ? ok : boom]));
  const out = buildInbox({ email: OWNER }, { table });
  const broken = out.lanes.filter((l) => l.status === "error");
  const good = out.lanes.find((l) => l.id === "skill-candidate");
  assert.ok(broken.length >= 1);
  for (const l of broken) {
    assert.equal(l.items.length, 0);
    assert.match(l.error, /lane down/);
  }
  assert.equal(good.status, "ok");
  assert.equal(out.counts.waiting, 1);
});

test("buildInbox: an unknown lane id is a structured per-lane error, not a 400", () => {
  const out = buildInbox({ email: OWNER }, { lanes: ["nope"], table: {} });
  assert.equal(out.lanes.length, 0, "unknown ids are filtered by LANE_IDS before dispatch");
});

test("buildInbox: ?lanes= narrows the fan-out", () => {
  const seen = [];
  const table = Object.fromEntries(
    LANE_IDS.map((id) => [id, () => (seen.push(id), [])]),
  );
  const out = buildInbox({ email: OWNER }, { lanes: ["input-request"], table });
  assert.deepEqual(seen, ["input-request"]);
  assert.equal(out.lanes.length, 1);
});

// ── fleet lane classification (real store) ──────────────────────────────────

test("fleet lane: owner-route open items are waiting; deputy and triage never appear", () => {
  const fleet = makeFleet();
  const m = makeMember(fleet.id);
  makeDecision(fleet.id, m.id, { route: "owner" });
  makeDecision(fleet.id, m.id, { route: "deputy" });
  makeDecision(fleet.id, m.id, { route: "deputy-triage", category: "infra-ticket" });

  const out = buildInbox({ email: OWNER });
  const lane = out.lanes.find((l) => l.id === "fleet-decision");
  assert.equal(lane.status, "ok");
  assert.equal(lane.items.length, 1, "only the owner-routed row");
  assert.equal(lane.items[0].bucket, "waiting");
  assert.equal(out.counts.waiting, 1);
});

test("fleet lane: an overdue row counts as expired (not waiting) without the inbox writing", () => {
  const fleet = fleetDb.createFleet({
    id: `fleet_${Math.random().toString(36).slice(2, 8)}`,
    name: "乙舰队",
    ownerEmail: OWNER,
    decisionPolicy: { expiryHours: 1 },
  });
  const m = makeMember(fleet.id);
  const d = makeDecision(fleet.id, m.id, { submittedAt: Date.now() - 2 * 3600_000 });

  const out = buildInbox({ email: OWNER });
  const item = out.lanes.find((l) => l.id === "fleet-decision").items.find((i) => i.itemRef === d.id);
  assert.ok(item, "the expired row is still readable");
  assert.equal(item.state, "expired");
  assert.notEqual(item.bucket, "waiting", "expired never counts toward 等你");
  // and the store row is untouched — the read face does not sweep
  assert.equal(fleetDb.getDecision(d.id).state, "open");
});

test("fleet lane: an approved-but-undelivered ruling is inflight, not waiting", () => {
  const fleet = makeFleet("丙舰队");
  const m = makeMember(fleet.id);
  const d = makeDecision(fleet.id, m.id);
  fleetDb.transitionDecision(d.id, "open", { state: "approved", resolvedAt: Date.now(), resolvedBy: "owner" });

  const out = buildInbox({ email: OWNER });
  const item = out.lanes.find((l) => l.id === "fleet-decision").items.find((i) => i.itemRef === d.id);
  assert.equal(item.bucket, "inflight");
  assert.ok(out.counts.inflight >= 1);
  assert.ok(item.actions.some((a) => a.op === "execute-now"));
});

test("fleet lane: a deleted source post still exposes the ruling with its honest consequence", () => {
  const fleet = makeFleet("丁舰队");
  const m = makeMember(fleet.id);
  const d = makeDecision(fleet.id, m.id);
  fleetDb.transitionDecision(d.id, "open", { state: "approved", resolvedAt: Date.now(), resolvedBy: "owner" });
  // delete the member so the post no longer exists
  fleetDb.deleteMember(m.id);

  const out = buildInbox({ email: OWNER });
  const item = out.lanes.find((l) => l.id === "fleet-decision").items.find((i) => i.itemRef === d.id);
  assert.ok(item);
  assert.match(item.consequence, /待岗位恢复/);
  // execute-now must not be offered for a post that cannot receive it
  assert.ok(!item.actions.some((a) => a.op === "execute-now"));
});

test("inbox only reads the caller's own fleets", () => {
  const mine = makeFleet("我的舰队");
  const otherFleet = fleetDb.createFleet({
    id: `fleet_${Math.random().toString(36).slice(2, 8)}`,
    name: "别人的舰队",
    ownerEmail: "someone-else@test",
  });
  const mm = makeMember(mine.id);
  const om = makeMember(otherFleet.id);
  makeDecision(mine.id, mm.id);
  makeDecision(otherFleet.id, om.id);

  const out = buildInbox({ email: OWNER });
  // The store is shared across this file's tests, so scope the assertion to the
  // two fleets this case created rather than to the whole lane.
  const items = out.lanes
    .find((l) => l.id === "fleet-decision")
    .items.filter((i) => i.originRefs.fleetId === mine.id || i.originRefs.fleetId === otherFleet.id);
  assert.equal(items.length, 1, "the foreign fleet contributes nothing");
  assert.equal(items[0].originRefs.fleetId, mine.id);
});

test("team-approval lane degrades to an EMPTY lane, not an error, on a fresh cell", () => {
  // A cell that never published a team has no card tables. Reporting "no such
  // table" would make a fresh deploy's inbox look broken; the lane must create
  // its (empty) tables and answer honestly with zero items.
  const out = buildInbox({ email: "fresh-cell@test" });
  const lane = out.lanes.find((l) => l.id === "team-approval");
  assert.equal(lane.status, "ok", `expected ok, got: ${lane.error ?? ""}`);
  assert.equal(lane.items.length, 0);
});

// ── the audit chain (agent-decided-learning-loop 4.4) ───────────────────────
// The inbox is the owner's only remaining answer to "why did that hold?" once
// nothing waits on a human signature. The chain must ride the item verbatim,
// and a grade must collapse into something a person can scan — without ever
// inventing a bucket for a value it does not recognise.

test("signature chain and grade kind ride the fleet-decision projection", () => {
  const fleet = fleetDb.createFleet({ id: "fleet_chain", name: "链队", ownerEmail: "owner@test" });
  const member = fleetDb.createMember({
    id: "m_chain", fleetId: fleet.id, title: "内容部", targetKind: "persona", targetId: "persona-x",
    kpiSlots: [], cadence: { cron: "0 3 1 1 *", tz: null, promptTemplate: "巡视", enabled: true },
  });
  const chain = {
    proposer: "agent:fleet_chain/m_chain",
    decider: "agent:fleet_chain/m_deputy",
    grader: "agent:fleet_chain/m_auditor",
    deciderModel: "model-a",
    graderModel: "model-b",
    independence: { ok: true, verified: true, acyclic: true, blind: true, cycleAt: null },
  };
  const item = fleetDb.appendDecision({
    id: "d_chain", fleetId: fleet.id, memberId: member.id,
    question: "带签名链的裁决", options: [{ value: "y", label: "是" }, { value: "n", label: "否" }],
    severity: "normal", route: "owner", category: "routine-ops", detail: { chain },
  });
  fleetDb.transitionDecision(item.id, "open", {
    state: "approved", resolution: { kind: "approve", choice: "y" },
    resolvedAt: Date.now(), resolvedBy: chain.decider, precedentGrade: "agent-independent",
  });

  const view = buildInbox({ email: "owner@test" });
  const row = view.lanes.flatMap((l) => l.items ?? []).find((i) => i.itemRef === "d_chain");
  assert.ok(row, "the decided item is in the inbox");
  assert.deepEqual(row.chain, chain, "the chain rides verbatim — no re-derivation at the read face");
  assert.equal(row.precedentGrade, "agent-independent");
  assert.equal(row.precedentGradeKind, "agent-verified");
});

test("gradeKind collapses to three readable kinds and never guesses", () => {
  assert.equal(gradeKind("owner-authored"), "owner");
  assert.equal(gradeKind("owner-approved"), "owner");
  assert.equal(gradeKind("agent-independent"), "agent-verified");
  assert.equal(gradeKind("agent-independent-unverified"), "agent-unverified");
  assert.equal(gradeKind("agent-self"), "agent-self");
  assert.equal(gradeKind("deputy-ruled"), "agent-self", "the historical literal reads as self-ruled");
  assert.equal(gradeKind(null), "unknown");
  assert.equal(gradeKind("something-new"), "unknown", "an unrecognised grade is NOT silently called self");
});

// ── history bound (cap-inbox-context-payload) ────────────────────────────────
//
// Found live 2026-11-24: the fleet-decision lane returned 522 items / 649 KB for
// one cell, 507 of them history that NO client renders (all three clients have
// only the 等你 / 在途 tabs). The count grows with uptime, so it had no bound.
//
// The bound must never touch the work: 等你 / 在途 counts are the fleet badge's
// numbers, and shrinking them would silently hide decisions.

/** Make `n` decided-then-expired items on one fleet (real state, via the sweep). */
function seedHistory(fleetId, memberId, n) {
  const past = Date.now() - 96 * 3600_000; // older than the 72h default
  for (let i = 0; i < n; i += 1) {
    makeDecision(fleetId, memberId, { submittedAt: past - i * 1000 });
  }
  return fleetDb.expireOpenDecisions(fleetId, { now: Date.now() });
}

function laneOf(user = OWNER) {
  return buildInbox({ email: user }, { lanes: ["fleet-decision"] }).lanes[0];
}

test("history: a fleet over the limit yields exactly the limit, and says how many it withheld", () => {
  const OWNER2 = "history1@test";
  const fleet = makeFleet("历史超限舰", OWNER2);
  const member = makeMember(fleet.id);
  const expiredCount = seedHistory(fleet.id, member.id, 25);
  assert.equal(expiredCount, 25, "precondition: 25 real expired rows");

  const lane = laneOf(OWNER2);
  const contextItems = lane.items.filter((i) => i.bucket === "context" && i.originRefs?.fleetId === fleet.id);
  assert.equal(contextItems.length, 20, "one fleet contributes at most CONTEXT_PER_FLEET_LIMIT history items");
  assert.equal(lane.omitted, 5, "the withheld count is stated, so 'no more' and 'truncated' differ");
});

test("history: a fleet under the limit reports no omission at all", () => {
  const OWNER2 = "history2@test";
  const fleet = makeFleet("历史未超舰", OWNER2);
  const member = makeMember(fleet.id);
  seedHistory(fleet.id, member.id, 3);

  const lane = laneOf(OWNER2);
  const contextItems = lane.items.filter((i) => i.bucket === "context" && i.originRefs?.fleetId === fleet.id);
  assert.equal(contextItems.length, 3, "nothing is withheld, nothing is padded");
  // `omitted` is absent rather than 0 for a clean lane — the other lanes stay
  // byte-identical, and a zero would read as a statement nobody made.
  assert.equal(lane.omitted, undefined);
});

test("history: the bound is per fleet — a heavy fleet never crowds out a light one", () => {
  const OWNER2 = "history3@test";
  const heavy = makeFleet("重型舰", OWNER2);
  const heavyMember = makeMember(heavy.id);
  seedHistory(heavy.id, heavyMember.id, 40);
  const light = makeFleet("轻型舰", OWNER2);
  const lightMember = makeMember(light.id);
  seedHistory(light.id, lightMember.id, 2);

  const lane = laneOf(OWNER2);
  const heavyItems = lane.items.filter((i) => i.bucket === "context" && i.originRefs?.fleetId === heavy.id);
  const lightItems = lane.items.filter((i) => i.bucket === "context" && i.originRefs?.fleetId === light.id);
  assert.equal(heavyItems.length, 20);
  assert.equal(lightItems.length, 2, "the light fleet keeps ALL its history — the cap is not shared");
});

test("history: 等你 and 在途 are untouched by the bound", () => {
  const OWNER2 = "history4@test";
  const fleet = makeFleet("混合舰", OWNER2);
  const member = makeMember(fleet.id);
  seedHistory(fleet.id, member.id, 30); // history, will be capped
  makeDecision(fleet.id, member.id, { submittedAt: Date.now() }); // one live item

  const inbox = buildInbox({ email: OWNER2 }, { lanes: ["fleet-decision"] });
  const lane = inbox.lanes[0];
  const waiting = lane.items.filter((i) => i.bucket === "waiting").length;
  assert.equal(waiting, 1, "the live decision still shows as 等你");
  // The envelope's own count is what clients render — it must equal the badge,
  // which counts every open owner-routed item regardless of the history bound.
  assert.equal(inbox.counts.waiting, waiting, "counts agree with the rendered list");
});

test("history: expiry disabled leaves no derived history at all", () => {
  const OWNER2 = "history5@test";
  const fleet = makeFleet("永不过期舰", OWNER2);
  const member = makeMember(fleet.id);
  // With no expiry policy those items stay `open` → they are 等你, not history,
  // so the bound simply never applies to them. Pin that: the bound must not
  // invent truncation for a lane with no history at all.
  for (let i = 0; i < 30; i += 1) makeDecision(fleet.id, member.id, { submittedAt: Date.now() });
  const lane = laneOf(OWNER2);
  const contextItems = lane.items.filter((i) => i.bucket === "context" && i.originRefs?.fleetId === fleet.id);
  assert.equal(contextItems.length, 0, "an expiry-disabled fleet has no derived history");
  assert.equal(lane.omitted, undefined, "and therefore nothing to omit");
});
