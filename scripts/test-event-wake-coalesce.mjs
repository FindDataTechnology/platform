// Event-wake coalescing (add-event-wake-coalesce).
//
// A chat burst is ONE conversation: "在吗" + "帮我看下昨天的数" + 一张图 arrive as
// three webhooks within seconds, and each used to wake the bound post with its
// own turn — three runs, three payments, and the post answering three
// fragments. The window collects a burst per (bot, chat) and wakes once.
//
// `EVENT_WAKE_COALESCE_MS=0` restores the previous behavior exactly; every
// assertion below that relies on the OLD shape sets it explicitly, so the
// off-switch is covered too.
//
// Run: node --test scripts/test-event-wake-coalesce.mjs

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wake-coalesce-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const engine = await import("../task-engine.js");
await engine.initTaskEngine({ broadcast: () => {}, runTurn: async () => ({ ok: true, text: "ok" }), isBusy: () => false });
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { triggerFleetEventWake, flushEventWakes, mergeWakeMessages, coalesceWindowMs } = await import(
  "../server/fleet-event-wake.js"
);

const fleetDb = createFleetDatabase({ file: path.join(tmpRoot, "fleets.db") });
setFleetDatabase(fleetDb);

const fleet = fleetDb.createFleet({ id: "f_wake", name: "唤醒舰", ownerEmail: "owner@test" });
fleetDb.createMember({ id: "w_duty", fleetId: fleet.id, title: "值班", targetKind: "persona", targetId: "p-duty", kpiSlots: [], cadence: null });
fleetDb.updateFleet(fleet.id, { orchestration: { mode: "schedule", edges: [{ kind: "event", from: "bot:b-coalesce", to: "w_duty" }] } });

const BOT = "b-coalesce";
const deps = { db: fleetDb, engine, roster: (id) => `roster:${id}` };
const wakeTasks = () =>
  (engine.allRecords() ?? []).filter((t) => t.origin?.event?.botId === BOT);

beforeEach(() => {
  for (const t of wakeTasks()) engine.removeTask?.(t.id);
});

test("merge: burst keeps the fragments, the last sender and the addressed flag", () => {
  const merged = mergeWakeMessages([
    { senderName: "甲", text: "在吗", addressed: false },
    { senderName: null, text: "  ", addressed: false }, // blank fragment is dropped, still counted
    { senderName: "乙", text: "帮我看下昨天的数", addressed: true },
  ]);
  assert.equal(merged.coalesced, 3, "the count is the burst size, not the kept size");
  assert.match(merged.text, /在吗/);
  assert.match(merged.text, /帮我看下昨天的数/);
  assert.doesNotMatch(merged.text, /\n---\n---\n/, "blank fragments never leave empty separators");
  assert.equal(merged.senderName, "乙", "the last human who spoke is who the post answers");
  assert.equal(merged.addressed, true, "any mention addresses the burst");
});

test("merge: an over-long burst is truncated WITH a mark, and dropped messages are named", () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ senderName: "甲", text: `第${i}条`, addressed: false }));
  const merged = mergeWakeMessages(many);
  assert.equal(merged.coalesced, 11);
  assert.match(merged.text, /此前另有 3 条同类消息已合并\/略去/, "8 kept of 11 → the dropped 3 are declared");
  assert.match(merged.text, /第10条/, "the tail (the newest) survives");
  assert.doesNotMatch(merged.text, /第0条/, "the head is what gets dropped first");

  const huge = mergeWakeMessages([{ senderName: "甲", text: "长".repeat(5000), addressed: false }]);
  assert.match(huge.text, /消息过长已截断/, "truncation is marked, never silent");
  assert.ok(huge.text.length <= 4000 + 40, "bounded");
});

test("window: a burst in one chat produces ONE wake carrying the whole conversation", async () => {
  delete process.env.EVENT_WAKE_COALESCE_MS; // default window
  assert.ok(coalesceWindowMs() > 0);
  const before = wakeTasks().length;
  triggerFleetEventWake(deps, BOT, { chatKey: "oc-1", senderName: "甲", text: "在吗" });
  triggerFleetEventWake(deps, BOT, { chatKey: "oc-1", senderName: "甲", text: "帮我看下昨天的数" });
  triggerFleetEventWake(deps, BOT, { chatKey: "oc-1", senderName: "乙", text: "顺便出个图" });
  assert.equal(wakeTasks().length, before, "nothing is created while the window is open");
  flushEventWakes();
  const created = wakeTasks().slice(before);
  assert.equal(created.length, 1, "one burst ⇒ one turn");
  assert.equal(created[0].origin.event.coalesced, 3, "the turn says how many messages it carries");
  assert.match(created[0].prompt, /在吗/);
  assert.match(created[0].prompt, /顺便出个图/);
  assert.match(created[0].prompt, /\{\{fleetEdgeContext\}\}$/, "the edge-context token survives coalescing");
});

test("window: different chats never merge", () => {
  const before = wakeTasks().length;
  triggerFleetEventWake(deps, BOT, { chatKey: "oc-a", senderName: "甲", text: "A 群的话" });
  triggerFleetEventWake(deps, BOT, { chatKey: "oc-b", senderName: "甲", text: "B 群的话" });
  flushEventWakes();
  const created = wakeTasks().slice(before);
  assert.equal(created.length, 2, "two conversations ⇒ two turns");
  assert.deepEqual(
    created.map((t) => t.origin.event.chatKey).sort(),
    ["oc-a", "oc-b"],
  );
  for (const t of created) assert.equal(t.origin.event.coalesced, undefined, "single-message wakes carry no count");
});

test("off switch: EVENT_WAKE_COALESCE_MS=0 restores one turn per message, synchronously", () => {
  process.env.EVENT_WAKE_COALESCE_MS = "0";
  try {
    const before = wakeTasks().length;
    const first = triggerFleetEventWake(deps, BOT, { chatKey: "oc-off", senderName: "甲", text: "第一条" });
    const second = triggerFleetEventWake(deps, BOT, { chatKey: "oc-off", senderName: "甲", text: "第二条" });
    assert.equal(first.length, 1, "the task exists immediately (old contract)");
    assert.equal(second.length, 1);
    const created = wakeTasks().slice(before);
    assert.equal(created.length, 2, "no coalescing when the window is zero");
    assert.equal(created[0].origin.event.coalesced, undefined);
    flushEventWakes(); // no-op
    assert.equal(wakeTasks().length, before + 2, "nothing was buffered");
  } finally {
    delete process.env.EVENT_WAKE_COALESCE_MS;
  }
});

test.after(async () => {
  flushEventWakes();
  await engine.idle?.();
  try { fleetDb.close(); } catch { /* shared handle */ }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});
