#!/usr/bin/env node
// ── One-off cleanup: duplicated fleet-report rows in ended rooms ─────────────
//
// Context (fix-zhiyu-room-lifecycle-and-bridge-watermark): the bridge used to
// keep its "already flowed" cursor on the transient sample object, so a report
// whose `at` never changed was re-appended every tick. Production accumulated
// 1018 copies of FOUR reports in one ended room. The code fix stops new ones;
// this script removes the existing plank.
//
// Dry-run is the default and prints one line per (room, at) group. `--apply`
// deletes all but the first (lowest seq) row of each group. Scope is narrow on
// purpose: only rooms whose status is 'ended', only rows whose meta says
// bridge="report". Nothing else is touched.
//
//   node scripts/cleanup-zhiyu-duplicate-bridge-rows.mjs [--db <path>]
//        [--room <id>] [--apply]
//
// The DB defaults to data/zhiyu.db relative to the repo root; in production the
// file is /data/cells/zhiyu.db and the platform pod is the only writer, so run
// it there (or against a copy) — never against a live WAL two writers share.

import path from "node:path";
import fs from "node:fs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const apply = has("--apply");
const roomFilter = val("--room");
const dbPath = val("--db") ?? path.resolve(process.cwd(), "data", "zhiyu.db");

if (!fs.existsSync(dbPath)) {
  console.error(`[cleanup] db not found: ${dbPath}`);
  process.exit(2);
}

const { default: Database } = await import("better-sqlite3");
const db = new Database(dbPath, apply ? {} : { readonly: true });
if (apply) db.pragma("journal_mode = WAL");

const where = [
  "m.kind IN ('system','event')",
  "json_extract(m.meta, '$.bridge') = 'report'",
  "json_extract(m.meta, '$.at') IS NOT NULL",
  "r.status = 'ended'",
];
const params = [];
if (roomFilter) {
  where.push("m.room_id = ?");
  params.push(roomFilter);
}

const groups = db
  .prepare(
    `SELECT m.room_id AS roomId,
            json_extract(m.meta, '$.at') AS at,
            COUNT(*) AS n,
            MIN(m.seq) AS keepSeq,
            GROUP_CONCAT(m.seq) AS seqs
       FROM zy_room_messages m
       JOIN zy_rooms r ON r.id = m.room_id
      WHERE ${where.join(" AND ")}
      GROUP BY m.room_id, at
     HAVING COUNT(*) > 1
      ORDER BY n DESC`,
  )
  .all(...params);

let totalDropped = 0;
for (const g of groups) {
  const keep = [];
  const drop = [];
  for (const s of String(g.seqs).split(",").map(Number)) (s === g.keepSeq ? keep : drop).push(s);
  totalDropped += drop.length;
  console.log(
    `[cleanup] room=${g.roomId} at=${g.at} rows=${g.n} keep=seq ${g.keepSeq} drop=${drop.length}` +
      (apply ? "" : "  (dry-run)"),
  );
}

if (groups.length === 0) {
  console.log("[cleanup] nothing to do — no duplicated report groups in ended rooms");
} else if (!apply) {
  console.log(`[cleanup] dry-run: ${groups.length} group(s), ${totalDropped} row(s) would be deleted`);
  console.log("[cleanup] re-run with --apply to delete (keeps the lowest seq of each group)");
} else {
  const del = db.prepare(
    `DELETE FROM zy_room_messages
      WHERE room_id = ?
        AND seq > ?
        AND json_extract(meta, '$.bridge') = 'report'
        AND json_extract(meta, '$.at') IS ?`,
  );
  let deleted = 0;
  const tx = db.transaction(() => {
    for (const g of groups) deleted += del.run(g.roomId, g.keepSeq, g.at).changes;
  });
  tx();
  console.log(`[cleanup] applied: deleted ${deleted} row(s) across ${groups.length} group(s)`);
}

db.close();
