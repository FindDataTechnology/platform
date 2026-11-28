#!/usr/bin/env node
// ── Broadcast notices survive the enter-the-page sweep (broadcast-reaches-zhiyu) ─
//
// The zhiyu page clears the unread lane on mount so the nav badge reaches zero
// deterministically. That is right for ambient notices ("you were invited") and
// WRONG for a broadcast: opening the page is not reading it, and clearing there
// loses the message before it can be seen.
//
// These pin the split, both directions:
//   · a broadcast survives mark-all-read and stays unread;
//   · every ambient type still clears, so the badge keeps its deterministic path.
//
//   node --test scripts/test-zhiyu-broadcast-notice.mjs

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

const { createZhiyuStore } = await import("../gateway/zhiyu/store.js");

const dir = mkdtempSync(path.join(os.tmpdir(), "zy-broadcast-"));
const store = createZhiyuStore({ file: path.join(dir, "zhiyu.db") });
const zy2 = createZhiyuStore({ file: path.join(dir, "zhiyu2.db") });
test.after(() => rmSync(dir, { recursive: true, force: true }));

const EMAIL = "someone@test";
const AMBIENT = ["invite", "call", "minutes", "budget_warning", "take_over", "handback", "room_ended"];

function seed() {
  store.notificationAdd({ email: EMAIL, type: "broadcast", payload: { title: "系统公告", body: "维护通知" } });
  for (const t of AMBIENT) store.notificationAdd({ email: EMAIL, type: t, payload: {} });
}

test("broadcast: carries its title and body through the store untouched", () => {
  store.notificationAdd({
    email: "carry@test",
    type: "broadcast",
    payload: { title: "T", body: "B", action: { actionId: "a.b" } },
  });
  const [row] = store.notificationsFor("carry@test", { unreadOnly: true });
  assert.equal(row.type, "broadcast");
  assert.equal(row.payload.title, "T");
  assert.equal(row.payload.body, "B");
  assert.deepEqual(row.payload.action, { actionId: "a.b" });
});

test("sweep: scoped mark-all-read clears the ambient types", () => {
  seed();
  const before = store.notificationUnreadCount(EMAIL);
  assert.equal(before, AMBIENT.length + 1, "one broadcast + every ambient type is unread");

  store.notificationMarkAllRead(EMAIL, { types: AMBIENT });

  const left = store.notificationsFor(EMAIL, { unreadOnly: true });
  assert.deepEqual(left.map((r) => r.type), ["broadcast"], "only the broadcast survives the sweep");
});

test("sweep: the broadcast is still readable after the sweep, body intact", () => {
  const [row] = store.notificationsFor(EMAIL, { unreadOnly: true });
  assert.equal(row.payload.title, "系统公告");
  assert.equal(row.payload.body, "维护通知");
});

test("sweep: an explicit read still clears the broadcast (the user's own act)", () => {
  const [row] = store.notificationsFor(EMAIL, { unreadOnly: true });
  store.notificationMarkRead(EMAIL, row.id);
  assert.equal(store.notificationUnreadCount(EMAIL), 0, "read-by-user is the only path that clears it");
});

test("sweep: no types argument keeps the historical clear-everything behaviour", () => {
  // The three existing producers must be unaffected: a caller that passes no
  // scope still gets the old semantics.
  store.notificationAdd({ email: "legacy@test", type: "invite", payload: {} });
  store.notificationAdd({ email: "legacy@test", type: "broadcast", payload: {} });
  assert.equal(store.notificationUnreadCount("legacy@test"), 2);
  store.notificationMarkAllRead("legacy@test");
  assert.equal(store.notificationUnreadCount("legacy@test"), 0, "unscoped sweep is unchanged");
});

// ── Read-state sync (sync-broadcast-read-state) ─────────────────────────────
//
// Reading a broadcast in the zhiyu face must also settle the row in the cell's
// aggregate inbox. The sync is fire-and-forget by design: a slow/stopped cell
// may leave the other face unread for a moment, but it must never undo the read
// the user already performed.

test("sync: notificationMarkRead RETURNS the row so the caller can act on it", () => {
  store.notificationAdd({ email: "sync@test", type: "broadcast", payload: { broadcastId: "bc_1", title: "t" } });
  const row = store.notificationsFor("sync@test", { unreadOnly: true }).find((n) => n.type === "broadcast");
  const cleared = store.notificationMarkRead("sync@test", row.id);
  assert.equal(cleared.type, "broadcast");
  assert.equal(cleared.payload.broadcastId, "bc_1", "the payload travels with the cleared row");
});

test("sync: a second read returns null (the caller must not sync twice)", () => {
  const row = store.notificationsFor("sync@test", { unreadOnly: true }).find((n) => n.type === "broadcast");
  assert.equal(row, undefined, "precondition: nothing unread");
  const again = store.notificationMarkRead("sync@test", "ntf_does_not_matter");
  assert.equal(again, null);
});

test("sync: an ambient type carries no broadcastId (no sync is attempted)", () => {
  store.notificationAdd({ email: "sync2@test", type: "invite", payload: { roomTitle: "R" } });
  const row = store.notificationsFor("sync2@test", { unreadOnly: true })[0];
  const cleared = store.notificationMarkRead("sync2@test", row.id);
  assert.equal(cleared.type, "invite");
  assert.equal(cleared.payload.broadcastId, undefined);
});

// ── Reverse machine face (sync-broadcast-read-both-ways) ────────────────────
//
// The route logic in one place, driven directly: the gateway clears the zhiyu
// row for (recipient, broadcastId) when the CELL says it was read there. The
// auth/HTTP shell around it is thin (real router test lives with the gateway);
// what matters here is the selection rule.
function clearByBroadcast(zy, { email, broadcastId }) {
  let changed = 0;
  for (const row of zy.notificationsFor(email, { unreadOnly: true })) {
    if (row.type !== "broadcast" || row.payload?.broadcastId !== broadcastId) continue;
    if (zy.notificationMarkRead(email, row.id)) changed += 1;
  }
  return changed;
}

test("reverse: the matching broadcast clears, a different broadcastId does not", () => {
  zy2.notificationAdd({ email: "r@x", type: "broadcast", payload: { broadcastId: "bc_A" } });
  zy2.notificationAdd({ email: "r@x", type: "broadcast", payload: { broadcastId: "bc_B" } });
  const changed = clearByBroadcast(zy2, { email: "r@x", broadcastId: "bc_A" });
  assert.equal(changed, 1);
  const left = zy2.notificationsFor("r@x", { unreadOnly: true });
  assert.deepEqual(left.map((n) => n.payload.broadcastId), ["bc_B"], "only the named broadcast clears");
});

test("reverse: an ambient notice is never touched by a broadcast id", () => {
  zy2.notificationAdd({ email: "r2@x", type: "invite", payload: { broadcastId: "bc_A" } });
  const changed = clearByBroadcast(zy2, { email: "r2@x", broadcastId: "bc_A" });
  assert.equal(changed, 0, "type must be broadcast, not merely carry the field");
  assert.equal(zy2.notificationUnreadCount("r2@x"), 1);
});

test("reverse: another recipient's row is untouched", () => {
  zy2.notificationAdd({ email: "other@x", type: "broadcast", payload: { broadcastId: "bc_A" } });
  clearByBroadcast(zy2, { email: "r@x", broadcastId: "bc_A" });
  assert.equal(zy2.notificationUnreadCount("other@x"), 1);
});
