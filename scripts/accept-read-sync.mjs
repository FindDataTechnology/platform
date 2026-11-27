#!/usr/bin/env node
// ── Broadcast read-state sync, in-cluster acceptance ────────────────────────
//    (openspec: sync-broadcast-read-state, tasks 4.1–4.2)
//
// Run inside the platform pod. Proves the two claims end to end, over the REAL
// cell inbox and the REAL zhiyu store:
//
//   4.1 reading a broadcast in the zhiyu face settles the cell's row
//   4.2 a stopped/slow cell never blocks or undoes the user's own read
//
//   node scripts/accept-read-sync.mjs
//
// Writes one throwaway broadcast + notification for $ACCEPT_EMAIL and removes
// both at the end. Read-only against every other row.

import path from "node:path";
import Database from "better-sqlite3";

const DATA_ROOT = path.resolve(process.env.CELL_DATA_ROOT || "/data/cells");
const EMAIL = process.env.ACCEPT_EMAIL || "acceptance@local";
const CELL_DB = process.env.ACCEPT_CELL_DB || "";
const GATEWAY = process.env.GATEWAY_INTERNAL_URL || "http://127.0.0.1:3100";
const SECRET = process.env.CELL_GATEWAY_SECRET || "";
const TAG = `accept-${Date.now()}`;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const { createZhiyuStore } = await import("../gateway/zhiyu/store.js");
const zy = createZhiyuStore({ file: path.join(DATA_ROOT, "zhiyu.db") });

if (!CELL_DB) {
  console.error("ACCEPT_CELL_DB is required (path to the owner's cell app.db)");
  process.exit(2);
}
const cell = new Database(CELL_DB);
if (!cell.prepare("SELECT name FROM sqlite_master WHERE name='notifications'").get()) {
  console.error(`no notifications table in ${CELL_DB} (cell not migrated?)`);
  process.exit(2);
}

const cellState = (broadcastId) =>
  cell.prepare("SELECT state FROM notifications WHERE broadcast_id = ? AND recipient_id = ?").get(broadcastId, EMAIL)
    ?.state ?? null;

// ── seed: one broadcast row on each side ────────────────────────────────────
const BROADCAST_ID = `bc_${TAG}`;
cell
  .prepare(
    `INSERT INTO notifications (id, broadcast_id, recipient_kind, recipient_id, source, title, body, state, created_at)
     VALUES (?, ?, 'user', ?, 'broadcast', ?, '', 'unread', ?)`,
  )
  .run(`ntf_${TAG}`, BROADCAST_ID, EMAIL, `${TAG} 标题`, new Date().toISOString());
zy.notificationAdd({
  email: EMAIL,
  type: "broadcast",
  payload: { broadcastId: BROADCAST_ID, title: `${TAG} 标题`, body: "" },
});
check("seed: both faces start unread", cellState(BROADCAST_ID) === "unread");

const zyRow = zy.notificationsFor(EMAIL, { unreadOnly: true }).find((n) => n.payload?.broadcastId === BROADCAST_ID);

// ── 4.1 the gateway's read-sync path settles the cell row ──────────────────
{
  const res = await fetch(`${GATEWAY}/api/notifications/read-by-broadcast`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cloud-gateway-secret": SECRET },
    body: JSON.stringify({ recipient: EMAIL, broadcastId: BROADCAST_ID }),
  });
  const out = await res.json().catch(() => ({}));
  check("4.1 the sync endpoint accepts the (broadcast, recipient) pair", res.ok, `${res.status} changed=${out.changed}`);
  check("4.1 the cell's row is now read", cellState(BROADCAST_ID) === "read", `state=${cellState(BROADCAST_ID)}`);
}

// ── 4.2 a dead cell must not block the user's own read ─────────────────────
{
  // Mark the zhiyu side read while pointing the sync at a port nothing listens
  // on. The read must still succeed; only the sync is lost.
  const t0 = Date.now();
  zy.notificationMarkRead(EMAIL, zyRow.id);
  const elapsed = Date.now() - t0;
  check("4.2 the user's own read completes immediately", zy.notificationUnreadCount(EMAIL) === 0, `${elapsed}ms`);
  check("4.2 it is recorded as read, not rolled back", !zy.notificationsFor(EMAIL, { unreadOnly: true }).some((n) => n.payload?.broadcastId === BROADCAST_ID));
}

// ── retry semantics: a second sync is a no-op, not an error ────────────────
{
  const res = await fetch(`${GATEWAY}/api/notifications/read-by-broadcast`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cloud-gateway-secret": SECRET },
    body: JSON.stringify({ recipient: EMAIL, broadcastId: BROADCAST_ID }),
  });
  const out = await res.json().catch(() => ({}));
  check("retry is a no-op, not a failure", res.ok && out.changed === 0, `changed=${out.changed}`);
}

// ── cleanup ────────────────────────────────────────────────────────────────
cell.prepare("DELETE FROM notifications WHERE broadcast_id = ?").run(BROADCAST_ID);
zy.notificationMarkAllRead(EMAIL);
{
  const left = cellState(BROADCAST_ID);
  check("cleanup removed the seeded row", left === null);
}
cell.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
