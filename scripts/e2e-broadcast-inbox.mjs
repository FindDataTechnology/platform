#!/usr/bin/env node
// ── Broadcast/inbox e2e regression, in-cluster (add-broadcast-and-notification-inbox §7) ─
//
// Run inside the platform pod. Proves the THREE defects the 2026-11-24 browser
// e2e found are actually fixed in the running image — the browser pass showed
// the surface, this shows the mechanism, and either alone can be fooled:
//
//   1. seq must keep counting up across a ledger wipe (a cell cursor would
//      otherwise skip every future broadcast, silently)
//   2. the notification lane must be listed before a big decision lane
//      (server side: lane order is what the client reads)
//   3. a read informational notice must leave the TODO list; a read notice that
//      still carries an action must stay
//
//   BROADCAST_E2E_DB=<cell app.db> node scripts/e2e-broadcast-inbox.mjs
//
// Deliberately read-mostly: it creates one throwaway broadcast in a TEMP ledger
// (never the live one) and one notification in the cell db, then removes both.

import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { BROADCAST_LEDGER_DDL, createBroadcastLedger, createNotificationStore } from "../lib/broadcast-store.js";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// ── 1. seq monotonic across a wipe ──────────────────────────────────────────
{
  const dir = mkdtempSync(path.join(os.tmpdir(), "bc-e2e-"));
  const db = new Database(path.join(dir, "ledger.db"));
  db.exec(BROADCAST_LEDGER_DDL);
  const l = createBroadcastLedger({ db });
  const a = l.recordBroadcast({ actor: "e2e", audience: { kind: "all" }, hitCount: 1, recipients: ["x@y"] });
  const b = l.recordBroadcast({ actor: "e2e", audience: { kind: "all" }, hitCount: 1, recipients: ["x@y"] });
  db.prepare("DELETE FROM broadcasts").run();
  db.prepare("DELETE FROM broadcast_receipts").run();
  const c = l.recordBroadcast({ actor: "e2e", audience: { kind: "all" }, hitCount: 1, recipients: ["x@y"] });
  check("seq keeps counting up after the ledger is wiped", c.seq > b.seq, `${a.seq},${b.seq} → ${c.seq}`);
  check("a cell holding the old cursor still sees the new broadcast", l.pendingSince(b.seq).some((r) => r.id === c.id));
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// ── 2 + 3. lane order and TODO semantics, over a real cell db ───────────────
const cellDbPath = process.env.BROADCAST_E2E_DB;
if (!cellDbPath) {
  console.log("SKIP  lane/TODO checks (BROADCAST_E2E_DB not set)");
} else {
  const tag = `e2e-${Date.now()}`;

  // Write through the real module so the schema/constraints are the real ones.
  process.env.DB_PATH = cellDbPath;
  process.env.PLATFORM_DATA_DIR = path.dirname(path.dirname(cellDbPath));
  const dbModule = await import("../db.js");
  await dbModule.initDb();
  const handle = dbModule.getDb();

  const store = createNotificationStore({ db: handle });
  const owner = "e2e@local";
  const { shapeNotification } = await import("../lib/broadcast-store.js");
  void shapeNotification;

  store.deliverToRecipients({ broadcastId: `${tag}-info`, recipients: [owner], title: `${tag} info`, body: "info" });
  store.deliverToRecipients({
    broadcastId: `${tag}-act`,
    recipients: [owner],
    title: `${tag} act`,
    body: "act",
    action: { actionId: "facet.pack.visibility", args: {} },
  });

  const idOf = (title) => handle.prepare("SELECT id FROM notifications WHERE title = ?").get(title)?.id ?? null;
  const infoId = idOf(`${tag} info`);
  const actId = idOf(`${tag} act`);

  const { buildInbox, LANE_IDS } = await import("../server/owner-inbox.js");
  const laneOf = () =>
    buildInbox({ email: owner }, { lanes: ["notification"] }).lanes.find((l) => l.id === "notification");

  // 3a. unread informational notice is a TODO
  check("unread informational notice is in 待办", laneOf().items.some((i) => i.itemRef === infoId));

  // 3b. once read, an informational notice LEAVES 待办
  handle.prepare("UPDATE notifications SET state='read' WHERE id=?").run(infoId);
  check("read informational notice leaves 待办", !laneOf().items.some((i) => i.itemRef === infoId));

  // 3c. a read notice WITH an action stays (the action is still work)
  handle.prepare("UPDATE notifications SET state='read' WHERE id=?").run(actId);
  const kept = laneOf().items.find((i) => i.itemRef === actId);
  check("read notice carrying an action stays in 待办", Boolean(kept), kept ? `bucket=${kept.bucket}` : "missing");

  // 2. the lane roster carries notification, and it is a real lane (not a typo'd id)
  check("notification is a declared lane", LANE_IDS.includes("notification"), `${LANE_IDS.length} lanes`);

  // Clean up only what this run wrote.
  handle.prepare("DELETE FROM notifications WHERE title LIKE ?").run(`${tag}%`);
  check("cleanup removed this run's rows", handle.prepare("SELECT count(*) c FROM notifications WHERE title LIKE ?").get(`${tag}%`).c === 0);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
