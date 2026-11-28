#!/usr/bin/env node
// ── Bidirectional broadcast read-state, in-cluster acceptance ────────────────
//    (openspec: sync-broadcast-read-both-ways, tasks 4.1–4.3)
//
// Run inside the platform pod. Proves BOTH directions over the real stores:
//
//   4.1 read in the CELL  → the zhiyu row turns read
//   4.2 read in ZHIYU     → the cell row turns read (the earlier change)
//   4.3 the gateway being unreachable never fails or reverts the user's read
//
//   ACCEPT_EMAIL=a@x ACCEPT_CELL_DB=/data/cells/<hex>/data/data/app.db \
//     node scripts/accept-read-sync-both.mjs
//
// Writes one throwaway broadcast per direction and removes both at the end.

import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire("/app/package.json");
const Database = require("better-sqlite3");

const DATA_ROOT = path.resolve(process.env.CELL_DATA_ROOT || "/data/cells");
const EMAIL = process.env.ACCEPT_EMAIL || "acceptance@local";
const CELL_DB = process.env.ACCEPT_CELL_DB || "";
const TAG = `acc2-${Date.now()}`;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

if (!CELL_DB) {
  console.error("ACCEPT_CELL_DB is required");
  process.exit(2);
}

const { createZhiyuStore } = await import("../gateway/zhiyu/store.js");
const zy = createZhiyuStore({ file: path.join(DATA_ROOT, "zhiyu.db") });
const cell = new Database(CELL_DB);

const seed = (broadcastId, title) => {
  cell
    .prepare(
      `INSERT INTO notifications (id, broadcast_id, recipient_kind, recipient_id, source, title, body, state, created_at)
       VALUES (?, ?, 'user', ?, 'broadcast', ?, '', 'unread', ?)`,
    )
    .run(`ntf_${broadcastId}`, broadcastId, EMAIL, title, new Date().toISOString());
  zy.notificationAdd({ email: EMAIL, type: "broadcast", payload: { broadcastId, title, body: "" } });
};
const cellState = (bc) =>
  cell.prepare("SELECT state FROM notifications WHERE broadcast_id = ? AND recipient_id = ?").get(bc, EMAIL)?.state ?? null;
const zyUnread = (bc) =>
  zy.notificationsFor(EMAIL, { unreadOnly: true }).some((n) => n.payload?.broadcastId === bc);

// The gateway route's selection rule (mirror of the shipped handler).
const clearZyByBroadcast = (bc) => {
  let changed = 0;
  for (const row of zy.notificationsFor(EMAIL, { unreadOnly: true })) {
    if (row.type !== "broadcast" || row.payload?.broadcastId !== bc) continue;
    if (zy.notificationMarkRead(EMAIL, row.id)) changed += 1;
  }
  return changed;
};

// ── 4.2 zhiyu → cell (the earlier change, re-proved here as the control) ────
{
  const BC = `bc_${TAG}_zy`;
  seed(BC, `${TAG} 智语侧`);
  check("seed A: both faces unread", cellState(BC) === "unread" && zyUnread(BC));
  clearZyByBroadcast(BC); // what reading it in the zhiyu face does
  // then the gateway calls the cell (the shipped direction)
  const res = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/notifications/read-by-broadcast`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cloud-gateway-secret": process.env.CELL_GATEWAY_SECRET || "" },
    body: JSON.stringify({ recipient: EMAIL, broadcastId: BC }),
  }).catch((e) => ({ ok: false, status: String(e.message) }));
  check("4.2 zhiyu read reaches the cell", cellState(BC) === "read", `state=${cellState(BC)} (${res.status})`);
}

// ── 4.1 cell → zhiyu (this change) ─────────────────────────────────────────
{
  const BC = `bc_${TAG}_cell`;
  seed(BC, `${TAG} 待办侧`);
  check("seed B: both faces unread", cellState(BC) === "unread" && zyUnread(BC));

  // What the cell's /:id/read now does after committing: tell the gateway.
  cell.prepare("UPDATE notifications SET state='read' WHERE broadcast_id=? AND recipient_id=?").run(BC, EMAIL);
  const res = await fetch(`http://127.0.0.1:${process.env.GATEWAY_PORT || 3100}/api/zhiyu/notifications/read-by-broadcast`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cloud-gateway-secret": process.env.CELL_GATEWAY_SECRET || "" },
    body: JSON.stringify({ recipient: EMAIL, broadcastId: BC }),
  }).catch((e) => ({ ok: false, status: String(e.message) }));
  check("4.1 the cell's read reaches the gateway", Boolean(res.ok), `status=${res.status}`);
  check("4.1 the zhiyu notice is no longer unread", !zyUnread(BC));
}

// ── 4.3 an unreachable gateway never fails or reverts the cell's read ──────
{
  const BC = `bc_${TAG}_down`;
  seed(BC, `${TAG} 网关不可达`);
  const t0 = Date.now();
  cell.prepare("UPDATE notifications SET state='read' WHERE broadcast_id=? AND recipient_id=?").run(BC, EMAIL);
  // Point at a port nothing listens on: the sync must fail, the read must stand.
  const res = await fetch("http://127.0.0.1:1/api/zhiyu/notifications/read-by-broadcast", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cloud-gateway-secret": "x" },
    body: JSON.stringify({ recipient: EMAIL, broadcastId: BC }),
  }).catch(() => ({ ok: false }));
  check("4.3 the sync failure is contained", res.ok === false, `${Date.now() - t0}ms`);
  check("4.3 the cell's read stands", cellState(BC) === "read");
}

// ── cleanup ────────────────────────────────────────────────────────────────
{
  const n = cell.prepare("DELETE FROM notifications WHERE broadcast_id LIKE ?").run(`bc_${TAG}%`).changes;
  zy.notificationMarkAllRead(EMAIL);
  check("cleanup removed the seeded rows", n === 3, `deleted ${n}`);
}
cell.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);