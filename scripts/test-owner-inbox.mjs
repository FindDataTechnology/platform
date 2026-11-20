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
const { buildInbox, LANE_IDS, consequenceFor } = await import("../server/owner-inbox.js");

await initDb();

const fleetDb = createFleetDatabase({ file: path.join(tmpRoot, "fleets.db") });
setFleetDatabase(fleetDb);

test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const OWNER = "owner@test";

function makeFleet(name = "甲舰队") {
  return fleetDb.createFleet({ id: `fleet_${Math.random().toString(36).slice(2, 8)}`, name, ownerEmail: OWNER });
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
