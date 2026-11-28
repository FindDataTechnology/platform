#!/usr/bin/env node
// ── Notification lane + routes (add-broadcast-and-notification-inbox 2.5) ────
//
// The properties that matter:
//   · the inbox lane is owner-scoped — another recipient's rows never appear,
//     and an unknown lane id stays a per-lane error (never a blank surface);
//   · the standalone read and the lane agree on unread;
//   · mark-read is owner-scoped: an id belonging to someone else answers 404,
//     the same as a nonexistent one.
//
// Boots the real db module (so the migration under test actually runs) and the
// real Express routes on an ephemeral port.
//
//   node --test scripts/test-notification-routes.mjs

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "notification-routes-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");

const dbModule = await import("../db.js");
await dbModule.initDb();
const { createNotificationStore } = await import("../lib/broadcast-store.js");
const { registerNotificationRoutes } = await import("../server/routes/notifications.js");
const { buildInbox, LANE_IDS } = await import("../server/owner-inbox.js");

test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const handle = dbModule.getDb();
const store = createNotificationStore({ db: handle });

// Two recipients, one broadcast each.
store.deliverToRecipients({ broadcastId: "bA", recipients: ["a@x"], title: "给 A", body: "A 的消息" });
store.deliverToRecipients({
  broadcastId: "bB",
  recipients: ["b@x"],
  title: "给 B",
  body: "B 的消息",
  action: { tool: "order_confirm", args: { orderId: "A-1024" } },
});

async function boot() {
  const app = express();
  app.use((req, _res, next) => {
    const email = req.headers["x-test-user"];
    if (email) req.user = { email: String(email), groups: [] };
    next();
  });
  // server.js mounts a global JSON parser before these routes; the harness must
  // do the same or every POST body arrives undefined (found while adding the
  // read-by-broadcast test — a 400 that looked like a route bug).
  app.use(express.json());
  registerNotificationRoutes(app, { authEnabled: true });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  // `body` is opt-in so every existing call keeps its exact shape.
  const call = (method, url, user, body) =>
    fetch(`${base}${url}`, {
      method,
      headers: {
        ...(user ? { "x-test-user": user } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { base, call, close: () => server.close() };
}

test("2.5 the lane roster carries notification as the last lane", () => {
  assert.equal(LANE_IDS.length, 9);
  assert.equal(LANE_IDS.at(-1), "notification");
});

test("inbox lane: only the caller's notifications appear, and the count matches", () => {
  const inbox = buildInbox({ email: "a@x" });
  const lane = inbox.lanes.find((l) => l.id === "notification");
  assert.equal(lane.status, "ok");
  assert.equal(lane.items.length, 1);
  assert.equal(lane.items[0].title, "给 A");
  assert.equal(lane.items[0].bucket, "waiting");
  assert.equal(inbox.counts.waiting, 1, "no other recipient's item leaks into the count");
});

test("inbox lane: the aggregate carries the notification lane (no separate request needed)", () => {
  const inbox = buildInbox({ email: "b@x" });
  const lane = inbox.lanes.find((l) => l.id === "notification");
  assert.equal(lane.items.length, 1);
  assert.deepEqual(lane.items[0].evidence.action, { tool: "order_confirm", args: { orderId: "A-1024" } });
});

test("inbox lane: a narrowed fan-out still answers the notification lane", () => {
  const inbox = buildInbox({ email: "a@x" }, { lanes: ["notification"] });
  assert.equal(inbox.lanes.length, 1);
  assert.equal(inbox.lanes[0].id, "notification");
});

test("GET /api/notifications: 401 without identity", async () => {
  const { call, close } = await boot();
  try {
    assert.equal((await call("GET", "/api/notifications")).status, 401);
  } finally {
    close();
  }
});

test("GET /api/notifications: returns only the caller's rows with the unread count", async () => {
  const { call, close } = await boot();
  try {
    const res = await call("GET", "/api/notifications", "a@x");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.notifications.length, 1);
    assert.equal(body.notifications[0].title, "给 A");
    assert.equal(body.unread, 1);
  } finally {
    close();
  }
});

test("POST read: marks the caller's own notification read once", async () => {
  const { call, close } = await boot();
  try {
    const [mine] = (await (await call("GET", "/api/notifications", "b@x")).json()).notifications;
    const first = await call("POST", `/api/notifications/${mine.id}/read`, "b@x");
    assert.equal(first.status, 200);
    assert.equal((await first.json()).changed, true);
    // Second time is a no-op, not an error.
    const second = await call("POST", `/api/notifications/${mine.id}/read`, "b@x");
    assert.equal(second.status, 200);
    assert.equal((await second.json()).changed, false);
    assert.equal((await (await call("GET", "/api/notifications", "b@x")).json()).unread, 0);
  } finally {
    close();
  }
});

test("POST read: someone else's notification answers 404 and is left untouched", async () => {
  const { call, close } = await boot();
  try {
    const [theirs] = (await (await call("GET", "/api/notifications", "a@x")).json()).notifications;
    const res = await call("POST", `/api/notifications/${theirs.id}/read`, "b@x");
    assert.equal(res.status, 404, "an id you do not own must not be distinguishable from a nonexistent one");
    // A's row is still unread.
    assert.equal((await (await call("GET", "/api/notifications", "a@x")).json()).unread, 1);
  } finally {
    close();
  }
});

test("POST read: nonexistent id answers 404 (same shape as someone else's)", async () => {
  const { call, close } = await boot();
  try {
    assert.equal((await call("POST", "/api/notifications/nope/read", "a@x")).status, 404);
  } finally {
    close();
  }
});

test("inbox lane: a read informational notice leaves 待办; a read notice WITH an action stays", () => {
  // Found live 2026-11-24: the lane listed `state <> 'acted'`, so an
  // informational notice the reader marked read stayed in 待办 forever.
  const withAction = handle.prepare("SELECT id FROM notifications WHERE recipient_id='b@x' AND action_json IS NOT NULL").get();
  const noAction = handle.prepare("SELECT id FROM notifications WHERE recipient_id='a@x' AND action_json IS NULL").get();
  handle.prepare("UPDATE notifications SET state='read' WHERE id IN (?,?)").run(withAction.id, noAction.id);

  const aLane = buildInbox({ email: "a@x" }, { lanes: ["notification"] }).lanes[0];
  assert.equal(aLane.items.length, 0, "a read informational notice is no longer a TODO");

  const bLane = buildInbox({ email: "b@x" }, { lanes: ["notification"] }).lanes[0];
  const kept = bLane.items.find((i) => i.itemRef === withAction.id);
  assert.ok(kept, "a read notice with an outstanding action is still a TODO");
  assert.equal(kept.bucket, "context", "it is seen, not new");
});

// ── Broadcast read-state sync (sync-broadcast-read-state) ────────────────────
//
// The gateway names (broadcast, recipient) — never a cell-internal id it could
// not know — and the cell settles exactly that row.

test("read-by-broadcast: marks that recipient's row read and reports the change", async () => {
  const { call, close } = await boot();
  try {
    const store2 = store; // the seeding helper at the top of this file
    store2.deliverToRecipients({ broadcastId: "bSync", recipients: ["c@x"], title: "同步", body: "b" });
    const res = await call("POST", "/api/notifications/read-by-broadcast", "c@x", {
      recipient: "c@x",
      broadcastId: "bSync",
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).changed, 1);
    assert.equal((await (await call("GET", "/api/notifications", "c@x")).json()).unread, 0, "the inbox now agrees");
  } finally {
    close();
  }
});

test("read-by-broadcast: another recipient's row is untouched", async () => {
  const { call, close } = await boot();
  try {
    store.deliverToRecipients({ broadcastId: "bSync2", recipients: ["d@x", "e@x"], title: "x", body: "b" });
    await call("POST", "/api/notifications/read-by-broadcast", "d@x", { recipient: "d@x", broadcastId: "bSync2" });
    assert.equal((await (await call("GET", "/api/notifications", "e@x")).json()).unread, 1, "e is still unread");
  } finally {
    close();
  }
});

test("read-by-broadcast: a repeat is a no-op, not an error", async () => {
  const { call, close } = await boot();
  try {
    store.deliverToRecipients({ broadcastId: "bSync3", recipients: ["f@x"], title: "x", body: "b" });
    const first = await (await call("POST", "/api/notifications/read-by-broadcast", "f@x", { recipient: "f@x", broadcastId: "bSync3" })).json();
    const second = await (await call("POST", "/api/notifications/read-by-broadcast", "f@x", { recipient: "f@x", broadcastId: "bSync3" })).json();
    assert.equal(first.changed, 1);
    assert.equal(second.changed, 0, "already read is a fact, not a failure");
  } finally {
    close();
  }
});

test("read-by-broadcast: missing fields are refused by name", async () => {
  const { call, close } = await boot();
  try {
    assert.equal((await call("POST", "/api/notifications/read-by-broadcast", "c@x", { recipient: "c@x" })).status, 400);
    assert.equal((await call("POST", "/api/notifications/read-by-broadcast", "c@x", { broadcastId: "b" })).status, 400);
  } finally {
    close();
  }
});
