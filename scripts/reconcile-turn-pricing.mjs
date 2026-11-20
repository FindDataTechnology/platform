#!/usr/bin/env node
// reconcile-turn-pricing (add-turn-pricing ③; v1.1 subject + v1.2 lane-view口径) —
// the estimate ↔ billing-truth reconciliation face. Run INSIDE the platform pod:
//
//   node scripts/reconcile-turn-pricing.mjs <owner-email> [YYYY-MM-DD] [--lane-key <key>]
//
// v1.2口径对齐 (§15.116挂账 v1.2): the billing truth is the LANE-KEY account's
// today_actual_cost — it covers EVERYTHING that rode the lane key today (every
// cell's fleet turns, chat usage, all models). The v1 estimate read ONE owner's
// fleets only, so the factor read 0.004 against $10.57 of account-wide spend.
// The estimate side now computes BOTH views:
//   • LANE VIEW (primary drift): every cell's member_turn_daily for the day —
//     the platform-metered share of the lane-key account (fleet turns only;
//     chat/non-fleet usage stays outside the platform's metering — documented
//     residual, never guessed).
//   • OWNER VIEW (secondary): the named owner's fleets (v1口径 kept for share
//     context: owner-est / lane-est).
// Residual gap = non-fleet usage on the account + unpriced samples + v1's
// excluded multipliers (group rate/discount/effort). A factor beyond ±30%
// (WARN line) prints a warning; calibration is a HUMAN decision — this script
// never writes anything.

import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { createSub2apiClient } from "../lib/sub2api-admin.js";

// v1.1 subject resolution (§15.116挂账): the lane-key account is the billed
// account; the owner-email account is the documented v1 fallback (labelled —
// it can read $0 while real spend flows). Exported for the unit test; the
// module imports safely (the CLI face lives under the entry guard below).
export async function resolveSubject({ client: c, ownerEmail: email, explicitKey = null }) {
  const key = (explicitKey ?? "").trim() || process.env.LLM_API_KEY?.trim() || "";
  if (key) {
    const hit = await c.findUserByKey(key);
    if (hit) return { ...hit, via: explicitKey ? "--lane-key" : "env LLM_API_KEY" };
    console.error("[reconcile] lane key unresolved on the 词元 side (stale/ambiguous) — falling back to the owner-email subject (v1口径, may read $0)");
  } else {
    console.error("[reconcile] no lane key available (env LLM_API_KEY empty) — falling back to the owner-email subject (v1口径, may read $0)");
  }
  const found = await c.findUserByEmail(email);
  return found ? { ...found, via: "owner-email" } : null;
}

// The cell data root: the gateway's cell registry (CELL_DATA_ROOT/cells-registry.db,
// table cell_registry) maps owner → cell id; each fleet DB lives at the 双层
// data path <CELL_DATA_ROOT>/<cellId>/data/data/fleets.db. The script runs in
// the PLATFORM pod — the gateway's registry db is mounted at /data/cells there
// (CELL_DATA_ROOT=/data/cells); locally it defaults to repo-root cell-data/.
function dataRoot() {
  return path.resolve(process.env.CELL_DATA_ROOT || "cell-data");
}

// The owner's cell fleet db (v1 owner view).
export function ownerCellDb(email) {
  const root = dataRoot();
  const reg = new Database(path.join(root, "cells-registry.db"), { readonly: true });
  try {
    const row = reg.prepare("SELECT cell_id, owner_email FROM cell_registry WHERE lower(owner_email) = lower(?)").get(email);
    if (!row) return null;
    return path.join(root, row.cell_id, "data", "data", "fleets.db");
  } finally {
    reg.close();
  }
}

// v1.2 lane view: EVERY cell's fleet db that exists on disk. Cells whose db
// is missing (never-opened cells) contribute nothing — honest absence, and
// the returned count of SCANNED cells says so.
export function allCellDbs() {
  const root = dataRoot();
  const reg = new Database(path.join(root, "cells-registry.db"), { readonly: true });
  const cells = [];
  try {
    const rows = reg.prepare("SELECT cell_id, owner_email FROM cell_registry ORDER BY cell_id").all();
    for (const r of rows) {
      const f = path.join(root, r.cell_id, "data", "data", "fleets.db");
      if (fs.existsSync(f)) cells.push({ cellId: r.cell_id, ownerEmail: r.owner_email, dbFile: f });
    }
  } finally {
    reg.close();
  }
  return cells;
}

// One cell's day estimate. ownerEmail filters to that owner's fleets (the v1
// owner view); null aggregates the whole cell (the lane view).
export function estimateCellDb(dbFile, day, ownerEmail = null) {
  const db = new Database(dbFile, { readonly: true });
  try {
    const hasDaily = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='member_turn_daily'")
      .get();
    if (!hasDaily) return { rows: [], est: 0, turns: 0, priced: 0 };
    const rows = db
      .prepare(
        `SELECT member_id, carrier, provider, model, turns,
                SUM(usage_input + usage_cached_input + usage_cache_write) AS billed_input,
                SUM(usage_output) AS output,
                SUM(cost_input_usd + cost_output_usd + cost_cache_write_usd + cost_cache_read_usd) AS est_usd,
                SUM(CASE WHEN pricing_at IS NOT NULL THEN 1 ELSE 0 END) AS priced_turns
         FROM member_turn_daily
         WHERE day = ?
           ${ownerEmail ? "AND EXISTS (SELECT 1 FROM fleets f WHERE f.id = member_turn_daily.fleet_id AND lower(f.owner_email) = lower(?))" : ""}
         GROUP BY member_id, carrier, provider, model
         ORDER BY est_usd DESC`,
      )
      .all(...(ownerEmail ? [day, ownerEmail] : [day]));
    return {
      rows,
      est: rows.reduce((acc, r) => acc + (r.est_usd ?? 0), 0),
      turns: rows.reduce((acc, r) => acc + (r.turns ?? 0), 0),
      priced: rows.reduce((acc, r) => acc + (r.priced_turns ?? 0), 0),
    };
  } finally {
    db.close();
  }
}

async function main({ client, ownerEmail, day, laneKeyArg = null }) {
  const warnLine = Number(process.env.PRICING_DRIFT_WARN || 0.3);

  // OWNER VIEW (v1口径 — the named owner's fleets).
  const ownerDbFile = ownerCellDb(ownerEmail);
  const owner = ownerDbFile ? estimateCellDb(ownerDbFile, day, ownerEmail) : { rows: [], est: 0, turns: 0, priced: 0 };

  // LANE VIEW (v1.2 primary — every cell; the lane key serves them all).
  const cells = allCellDbs();
  const laneRows = [];
  let laneEst = 0;
  let laneTurns = 0;
  let lanePriced = 0;
  const perCell = [];
  for (const c of cells) {
    try {
      const e = estimateCellDb(c.dbFile, day, null);
      if (e.turns > 0) {
        perCell.push({ cellId: c.cellId.slice(0, 8), owner: c.ownerEmail, est: e.est, turns: e.turns, priced: e.priced });
        laneRows.push(...e.rows.map((r) => ({ ...r, cell: c.cellId.slice(0, 8) })));
      }
      laneEst += e.est;
      laneTurns += e.turns;
      lanePriced += e.priced;
    } catch (e) {
      console.error(`[reconcile] cell ${c.cellId.slice(0, 8)} skipped: ${e.message}`);
    }
  }
  perCell.sort((a, b) => b.est - a.est);

  const subject = await resolveSubject({ client, ownerEmail, explicitKey: laneKeyArg });
  if (!subject) {
    console.error(`[reconcile] no sub2api account resolvable for ${ownerEmail} (lane key and email both miss)`);
    process.exit(1);
  }
  const truth = await client.readUserUsageToday(subject.userId);
  const actual = truth?.todayActualCost ?? null;

  const factor = laneEst > 0 && actual != null && actual > 0 ? laneEst / actual : null;
  const over = factor != null && Math.abs(factor - 1) > warnLine;
  const ownerShare = laneEst > 0 ? owner.est / laneEst : null;
  console.log(`[reconcile] day=${day} owner=${ownerEmail} subject=${subject.email ?? subject.userId} (via ${subject.via})`);
  console.log(`  LANE estimate (v1.2, ${cells.length} cells scanned): $${laneEst.toFixed(4)} (priced ${lanePriced}/${laneTurns} turn-days) — the platform-metered share of the lane-key account`);
  console.log(`  词元 actual (today): ${actual == null ? "unavailable" : "$" + actual.toFixed(4)}`);
  console.log(`  drift factor (lane-est/actual): ${factor == null ? "n/a" : factor.toFixed(3)}${over ? "  ⚠️ beyond the ±30% line" : ""}`);
  console.log(`  owner view (v1口径, share of lane est): $${owner.est.toFixed(4)} (priced ${owner.priced}/${owner.turns})${ownerShare != null ? ` — ${(ownerShare * 100).toFixed(1)}%` : ""}`);
  console.log(`  residual: non-fleet usage on the account (chat etc.) + unpriced samples + excluded multipliers — never guessed`);
  if (perCell.length) {
    console.log("  top cells:");
    for (const c of perCell.slice(0, 5)) {
      console.log(`    ${c.cellId} (${c.owner}) ×${c.turns} turns est=$${c.est.toFixed(4)}`);
    }
  }
  if (laneRows.length) {
    console.log("  top contributors:");
    for (const r of laneRows.slice(0, 5)) {
      console.log(`    ${r.cell} ${r.member_id} ${r.carrier ?? "-"} ${r.model ?? "-"} ×${r.turns} est=$${(r.est_usd ?? 0).toFixed(4)}`);
    }
  }
  if (over) console.warn(`[reconcile] WARN drift ${factor.toFixed(3)} beyond ±${warnLine} — residual = non-fleet usage + unpriced samples + excluded multipliers; calibration is a human call`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const flagIdx = argv.indexOf("--lane-key");
  const laneKeyArg = flagIdx >= 0 ? (argv.splice(flagIdx, 2)[1] ?? "") : null;
  const [ownerEmail, dayArg] = argv;
  if (!ownerEmail) {
    console.error("usage: node scripts/reconcile-turn-pricing.mjs <owner-email> [YYYY-MM-DD] [--lane-key <key>]");
    process.exit(2);
  }
  const client = createSub2apiClient();
  if (client.degraded()) {
    console.error("[reconcile] SUB2API_ADMIN_KEY not configured — cannot read the billing truth");
    process.exit(1);
  }
  main({ client, ownerEmail, day: dayArg ?? new Date().toISOString().slice(0, 10), laneKeyArg }).catch((e) => {
    console.error(`[reconcile] failed: ${e?.message || e}`);
    process.exit(1);
  });
}
