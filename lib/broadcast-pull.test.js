// Tests for the cell-side broadcast pull loop
// (add-broadcast-and-notification-inbox 2.4).
//
// The properties that matter, each a real failure mode of a distributed pull:
//   · strict monotonic cursor (a timestamp or a non-advancing cursor silently
//     re-delivers or skips);
//   · a gateway failure leaves the cursor untouched so the next tick retries;
//   · a cell only materializes notifications for ITS OWN owner;
//   · re-reading the same page after a crash inserts nothing (idempotent).
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createBroadcastPuller, CURSOR_KEY } from "./broadcast-pull.js";

function cellDb() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE deployment_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE notifications (id TEXT PRIMARY KEY, broadcast_id TEXT, recipient_kind TEXT NOT NULL,
    recipient_id TEXT NOT NULL, source TEXT NOT NULL, ref_json TEXT, action_json TEXT,
    title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'unread',
    created_at TEXT NOT NULL, acted_at TEXT, acted_by TEXT)`);
  db.exec(`CREATE UNIQUE INDEX idx_nb ON notifications(broadcast_id, recipient_id) WHERE broadcast_id IS NOT NULL`);
  return db;
}

/** A fake gateway: serves `broadcasts`, records receipts. */
function fakeGateway(broadcasts) {
  const receipts = [];
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body });
    if (String(url).includes("/pending")) {
      const since = Number(new URL(url).searchParams.get("since") ?? 0);
      return jsonRes({ broadcasts: broadcasts.filter((b) => b.seq > since) });
    }
    if (String(url).includes("/receipt")) {
      receipts.push(JSON.parse(init.body));
      return jsonRes({ applied: true });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchImpl, receipts, calls };
}

function jsonRes(body) {
  return { ok: true, status: 200, json: async () => body };
}

function puller(db, { broadcasts = [], fetchImpl, ownerEmail = "me@x", cellId = "cell1" } = {}) {
  const gw = fetchImpl ? { fetchImpl } : fakeGateway(broadcasts);
  const p = createBroadcastPuller({
    db,
    cellId,
    ownerEmail,
    gatewayBase: () => "http://gw",
    gatewaySecret: () => "s",
    fetchImpl: gw.fetchImpl,
    now: () => "2026-11-24T00:00:00Z",
  });
  return { p, gw };
}

const b = (seq, recipients, extra = {}) => ({
  id: `b${seq}`,
  seq,
  actor: "admin@x",
  audience: { kind: "userIds", ids: recipients },
  recipients,
  title: `t${seq}`,
  body: `m${seq}`,
  hitCount: recipients.length,
  wake: "none",
  createdAt: "t",
  ...extra,
});

test("pull: a broadcast addressed to this owner lands one notification", async () => {
  const db = cellDb();
  const { p } = puller(db, { broadcasts: [b(1, ["me@x"])] });
  const r = await p.pullOnce();
  assert.equal(r.delivered, 1);
  assert.equal(p.store.unreadCount({ recipientKind: "user", recipientId: "me@x" }), 1);
});

test("pull: a broadcast addressed to someone else lands nothing (and still advances)", async () => {
  const db = cellDb();
  const { p } = puller(db, { broadcasts: [b(1, ["other@x"])] });
  const r = await p.pullOnce();
  assert.equal(r.delivered, 0);
  assert.equal(p.store.unreadCount({ recipientKind: "user", recipientId: "me@x" }), 0);
  assert.equal(r.cursor, 1, "a broadcast that is not ours must not be re-read forever");
});

test("pull: the cursor advances and a second call re-reads nothing", async () => {
  const db = cellDb();
  const { p } = puller(db, { broadcasts: [b(1, ["me@x"]), b(2, ["me@x"])] });
  assert.equal((await p.pullOnce()).delivered, 2);
  assert.equal(p.readCursor(), 2);
  assert.equal((await p.pullOnce()).delivered, 0);
  assert.equal(p.store.listFor({ recipientKind: "user", recipientId: "me@x" }).length, 2, "idempotent, no duplicates");
});

test("pull: a gateway failure leaves the cursor untouched", async () => {
  const db = cellDb();
  const fetchImpl = async () => ({ ok: false, status: 502, json: async () => ({}) });
  const { p } = puller(db, { fetchImpl });
  await assert.rejects(() => p.pullOnce(), /gateway answered 502/);
  assert.equal(p.readCursor(), 0, "the next tick must retry the same page");
});

test("pull: a crash mid-page re-reads without duplicating (idempotent replay)", async () => {
  const db = cellDb();
  const { p } = puller(db, { broadcasts: [b(1, ["me@x"])] });
  await p.pullOnce();
  // Simulate losing the cursor write while the notification rows survived.
  db.prepare("DELETE FROM deployment_config WHERE key = ?").run(CURSOR_KEY);
  assert.equal(p.readCursor(), 0);
  await p.pullOnce();
  assert.equal(p.store.listFor({ recipientKind: "user", recipientId: "me@x" }).length, 1, "no duplicate row");
});

test("pull: a delivery failure holds the cursor so the recipient retries", async () => {
  const db = cellDb();
  // Two broadcasts; the second one fails to insert (a bad row shape) — the
  // cursor must stop BEFORE it, not past it.
  const { p } = puller(db, { broadcasts: [b(1, ["me@x"]), b(2, ["me@x"])] });
  db.exec(`CREATE TRIGGER boom BEFORE INSERT ON notifications WHEN NEW.broadcast_id = 'b2'
           BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
  const r = await p.pullOnce();
  assert.equal(r.failed, 1);
  assert.equal(p.readCursor(), 1, "cursor stops before the failed broadcast, so the next tick retries it");
});

test("pull: the receipt reports this cell's own identity and counts", async () => {
  const db = cellDb();
  const { p, gw } = puller(db, { broadcasts: [b(1, ["me@x"])] });
  await p.pullOnce();
  assert.equal(gw.receipts.length, 1);
  assert.deepEqual(gw.receipts[0], { cellId: "cell1", ok: 1, fail: 0 });
});

test("pull: no owner email is a no-op, not an unfiltered fan-out", async () => {
  const db = cellDb();
  const { p, gw } = puller(db, { broadcasts: [], ownerEmail: "" });
  const r = await p.pullOnce();
  assert.equal(r.delivered, 0);
  assert.equal(gw.calls.length, 0, "it must not even ask — an anonymous cell has no audience");
});

// ── Wake (design D4) ────────────────────────────────────────────────────────
//
// The cost model is the reason this exists: a broadcast to 500 recipients must
// not become 500 turns unless the operator said `immediate`, and even then the
// wake must run against an inbox that already has the rows.

const withWake = (seq, recipients, wake) => b(seq, recipients, { wake });

test("wake: default (none) never calls the hook, even with a recipient hit", async () => {
  const db = cellDb();
  const calls = [];
  const { fetchImpl } = fakeGateway([withWake(1, ["me@x"], "none")]);
  const p = createBroadcastPuller({
    db,
    cellId: "cell1",
    ownerEmail: "me@x",
    gatewayBase: () => "http://gw",
    gatewaySecret: () => "s",
    fetchImpl,
    now: () => "2026-11-24T00:00:00Z",
    wake: async (args) => calls.push(args),
  });
  const r = await p.pullOnce();
  assert.equal(r.delivered, 1);
  assert.equal(r.woke, 0);
  assert.equal(calls.length, 0);
});

test("wake: batch coalesces the cycle into ONE call that names every broadcast", async () => {
  const db = cellDb();
  const calls = [];
  const { fetchImpl } = fakeGateway([withWake(1, ["me@x"], "batch"), withWake(2, ["me@x"], "batch")]);
  const p = createBroadcastPuller({
    db,
    cellId: "cell1",
    ownerEmail: "me@x",
    gatewayBase: () => "http://gw",
    gatewaySecret: () => "s",
    fetchImpl,
    now: () => "2026-11-24T00:00:00Z",
    wake: async (args) => calls.push(args),
  });
  const r = await p.pullOnce();
  assert.equal(r.woke, 1, "two broadcasts, one turn");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, "batch");
  assert.equal(calls[0].broadcasts.length, 2);
});

test("wake: the rows are committed BEFORE the hook runs (a wake never sees an empty inbox)", async () => {
  const db = cellDb();
  let seenAtWake = null;
  const { fetchImpl } = fakeGateway([withWake(1, ["me@x"], "immediate")]);
  const p = createBroadcastPuller({
    db,
    cellId: "cell1",
    ownerEmail: "me@x",
    gatewayBase: () => "http://gw",
    gatewaySecret: () => "s",
    fetchImpl,
    now: () => "2026-11-24T00:00:00Z",
    wake: async () => {
      seenAtWake = {
        rows: db.prepare("SELECT count(*) AS c FROM notifications").get().c,
        cursor: Number(db.prepare("SELECT value FROM deployment_config WHERE key = ?").get(CURSOR_KEY)?.value ?? 0),
      };
    },
  });
  await p.pullOnce();
  assert.equal(seenAtWake.rows, 1, "the notification row is durable before the agent is woken");
  assert.equal(seenAtWake.cursor, 1, "the cursor moved too — a crash after the wake must not re-deliver");
});

test("wake: a failing hook is reported, not retried, and the notification survives", async () => {
  const db = cellDb();
  const { fetchImpl } = fakeGateway([withWake(1, ["me@x"], "batch")]);
  const p = createBroadcastPuller({
    db,
    cellId: "cell1",
    ownerEmail: "me@x",
    gatewayBase: () => "http://gw",
    gatewaySecret: () => "s",
    fetchImpl,
    now: () => "2026-11-24T00:00:00Z",
    wake: async () => {
      throw new Error("runtime not ready");
    },
  });
  const r = await p.pullOnce();
  assert.equal(r.delivered, 1, "the notification is delivered regardless");
  assert.equal(r.woke, 0);
  assert.match(r.wakeError, /runtime not ready/);
  assert.equal(p.readCursor(), 1, "a failed wake must not hold the cursor — the rows are already there");
});

test("wake: a broadcast addressed to nobody here wakes nothing", async () => {
  const db = cellDb();
  const calls = [];
  const { fetchImpl } = fakeGateway([withWake(1, ["other@x"], "immediate")]);
  const p = createBroadcastPuller({
    db,
    cellId: "cell1",
    ownerEmail: "me@x",
    gatewayBase: () => "http://gw",
    gatewaySecret: () => "s",
    fetchImpl,
    now: () => "2026-11-24T00:00:00Z",
    wake: async (args) => calls.push(args),
  });
  const r = await p.pullOnce();
  assert.equal(r.delivered, 0);
  assert.equal(calls.length, 0);
});

// ── External channels (P4) ──────────────────────────────────────────────────
//
// The rule these pin: the inbox row is the source of truth. A channel that is
// unconfigured, missing, or broken may change "was it also emailed", never
// "did they get the notification".

function pullerWithChannels(db, broadcasts, channels) {
  const { fetchImpl } = fakeGateway(broadcasts);
  return createBroadcastPuller({
    db,
    cellId: "cell1",
    ownerEmail: "me@x",
    gatewayBase: () => "http://gw",
    gatewaySecret: () => "s",
    fetchImpl,
    now: () => "2026-11-24T00:00:00Z",
    channels,
  });
}

test("channel: email is called once per delivered broadcast", async () => {
  const db = cellDb();
  const sent = [];
  const p = pullerWithChannels(db, [b(1, ["me@x"])], {
    email: async (m) => {
      sent.push(m);
      return { sent: true };
    },
  });
  await p.pullOnce();
  assert.deepEqual(sent.map((m) => m.to), ["me@x"]);
  assert.equal(p.store.unreadCount({ recipientKind: "user", recipientId: "me@x" }), 1);
});

test("channel: a throwing channel leaves the notification delivered", async () => {
  const db = cellDb();
  const p = pullerWithChannels(db, [b(1, ["me@x"])], {
    email: async () => {
      throw new Error("smtp down");
    },
  });
  const r = await p.pullOnce();
  assert.equal(r.delivered, 1, "the inbox row is the deliverable");
  assert.equal(r.failed, 1, "the channel failure is reported, not hidden");
  assert.equal(p.store.unreadCount({ recipientKind: "user", recipientId: "me@x" }), 1);
});

test("channel: no channel configured is a skip, not a failure", async () => {
  const db = cellDb();
  const p = pullerWithChannels(db, [b(1, ["me@x"])], {});
  const r = await p.pullOnce();
  assert.equal(r.delivered, 1);
  assert.equal(r.failed, 0, "an unconfigured channel is a normal state");
});

test("channel: a broadcast not addressed here triggers no channel call", async () => {
  const db = cellDb();
  let calls = 0;
  const p = pullerWithChannels(db, [b(1, ["other@x"])], {
    email: async () => {
      calls += 1;
      return { sent: true };
    },
  });
  await p.pullOnce();
  assert.equal(calls, 0);
});
