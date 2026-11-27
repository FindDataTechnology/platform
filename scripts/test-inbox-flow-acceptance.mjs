#!/usr/bin/env node
// ── Flow acceptance in the owner inbox (add-task-flow, task 7.1)
//
// The lane's four obligations, each pinned by a case:
//   1. a settled-but-unaccepted card APPEARS (that is the whole point);
//   2. accepting it makes it DISAPPEAR;
//   3. another user's card never appears (nor affects the count);
//   4. this lane failing degrades ONLY this lane.
//
//   node --test scripts/test-inbox-flow-acceptance.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "inbox-flow-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");
process.env.DB_PATH = path.join(tmpRoot, "app.db");

const engine = await import("../task-engine.js");
const inbox = await import("../server/owner-inbox.js");

test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const OWNER = "owner@example.com";

function card({ id, owner = OWNER, state = "done", verdict = null }) {
  engine.insertTask({
    id,
    trigger: "manual",
    type: "manual",
    prompt: `work ${id}`,
    preset: "p1",
    targetType: "persona",
    sessionId: `task-${id}`,
    sessionTitle: `卡片 ${id}`,
    status: "manual",
    createdAt: new Date().toISOString(),
    state,
    flow: {
      flowId: "content",
      stationId: "gate",
      owner,
      acceptance: [{ id: "a1", kind: "artifact-exists", target: "x.md" }],
      stakedAt: new Date().toISOString(),
      verdict,
    },
  });
}

test("7.1 a settled card without a ruling is waiting on the owner", async () => {
  await engine.initTaskEngine({ broadcast: () => {}, isBusy: () => false, runTurn: async () => ({ ok: true }) });
  card({ id: "card_a" });

  const payload = inbox.buildInbox({ email: OWNER }, { lanes: ["flow-acceptance"] });
  const lane = payload.lanes.find((l) => l.id === "flow-acceptance");
  assert.equal(lane.status, "ok", JSON.stringify(lane));
  assert.equal(lane.items.length, 1);
  const item = lane.items[0];
  assert.equal(item.itemRef, "card_a");
  assert.equal(item.bucket, "waiting");
  // The consequence sentence must come from the lane's own criteria fields.
  assert.ok(item.consequence.includes("1 条机器判据"), item.consequence);
  // The action points at the flow route — no second write path is invented.
  assert.equal(item.actions[0].endpoint, "/api/flows/cards/card_a/accept");
});

test("7.1 an accepted card leaves the lane", async () => {
  await engine.initTaskEngine({ broadcast: () => {}, isBusy: () => false, runTurn: async () => ({ ok: true }) });
  card({ id: "card_b", verdict: { outcome: "pass", by: "criteria", at: new Date().toISOString() } });
  const payload = inbox.buildInbox({ email: OWNER }, { lanes: ["flow-acceptance"] });
  const lane = payload.lanes.find((l) => l.id === "flow-acceptance");
  assert.equal(lane.items.length, 0, "a ruled card is not waiting on anyone");
});

test("7.1 a backlog card is not in this lane (it waits on dispatch, not a signature)", async () => {
  await engine.initTaskEngine({ broadcast: () => {}, isBusy: () => false, runTurn: async () => ({ ok: true }) });
  card({ id: "card_c", state: null });
  const payload = inbox.buildInbox({ email: OWNER }, { lanes: ["flow-acceptance"] });
  assert.equal(payload.lanes[0].items.length, 0);
});

test("7.1 another user's cards never appear, and never affect the count", async () => {
  await engine.initTaskEngine({ broadcast: () => {}, isBusy: () => false, runTurn: async () => ({ ok: true }) });
  card({ id: "card_mine", owner: OWNER });
  card({ id: "card_theirs", owner: "someone@else.com" });
  card({ id: "card_orphan", owner: null });

  const payload = inbox.buildInbox({ email: OWNER }, { lanes: ["flow-acceptance"] });
  const lane = payload.lanes[0];
  assert.deepEqual(lane.items.map((i) => i.itemRef), ["card_mine"], "只有本人的卡片出现");
  assert.equal(payload.counts.waiting, 1, "计数也不含他人卡片");
});

test("7.1 the lane failing degrades only itself", async () => {
  await engine.initTaskEngine({ broadcast: () => {}, isBusy: () => false, runTurn: async () => ({ ok: true }) });
  const table = {
    "flow-acceptance": () => { throw new Error("task engine unreadable"); },
    "skill-candidate": () => [{ laneId: "skill-candidate", itemRef: "s1", bucket: "waiting", title: "t", consequence: "c", actions: [] }],
  };
  const payload = inbox.buildInbox({ email: OWNER }, { lanes: ["flow-acceptance", "skill-candidate"], table });
  const broken = payload.lanes.find((l) => l.id === "flow-acceptance");
  const healthy = payload.lanes.find((l) => l.id === "skill-candidate");
  assert.equal(broken.status, "error");
  assert.ok(broken.error.includes("unreadable"));
  assert.equal(healthy.status, "ok", "the other lane is unaffected");
  assert.equal(healthy.items.length, 1);
});

test("7.1 the lane id is declared, so it cannot be half-added", () => {
  // LANE_IDS is the declaration that a lane exists; LANE_LABELS names it. A
  // lane added to one and not the other shows up as a raw id on screen — that
  // is the degraded-but-honest shape, and it must remain reachable.
  assert.ok(inbox.LANE_IDS.includes("flow-acceptance"));
});
