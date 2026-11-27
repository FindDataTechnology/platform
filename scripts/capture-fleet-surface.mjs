#!/usr/bin/env node
// ── Freeze the fleet read/write surface before splitting fleets.js ───────────
//
// openspec change: converge-fleet-surface. The split (4,680-line route file →
// assembly + write face + views) is only safe if the observable surface is
// identical before and after. "Looks the same in review" is not a judge; a
// byte-for-byte comparison of real responses is.
//
// Two modes:
//   --capture   drive a real in-process server over a fixed fixture and write
//               evidence/api-baseline.json
//   --compare   (default) drive the SAME fixture, compare against the baseline,
//               and print every differing JSON path
//
// The fixture is built from the real store API (not hand-written JSON), so the
// shapes are whatever the code actually produces — a fabricated fixture would
// pass while the real endpoint changed.
//
// Run: node scripts/capture-fleet-surface.mjs --capture
//      node scripts/capture-fleet-surface.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = path.join(REPO, "scripts", "fixtures", "fleet-surface-baseline.json");
const CAPTURE = process.argv.includes("--capture");

import { canonical, compareSurfaces } from "./lib/fleet-surface-compare.mjs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-surface-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const cron = await import("../cron.js");
const chatHistory = await import("../chat-history.js");
const { initDb } = await import("../db.js");
const engine = await import("../task-engine.js");
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { createFleetRoutes } = await import("../server/routes/fleets.js");

await initDb();
await chatHistory.initChatHistory();
fs.writeFileSync(path.join(tmpRoot, "jobs.json"), "[]");
await engine.initTaskEngine({ broadcast: () => {}, runTurn: async () => ({ ok: true }), isBusy: () => false });

const fleetDb = createFleetDatabase({ file: path.join(tmpRoot, "fleets.db") });
setFleetDatabase(fleetDb);

// ── Fixture: three fleets covering the shapes the views branch on ────────────
//  A: two persona posts joined by a handoff edge (the common case)
//  B: a fleet whose post target is gone (the "vacant/missing" branch)
//  C: an empty fleet (the zero-state branch every view must render honestly)
const A = fleetDb.createFleet({ id: "fleet_fixture_a", name: "甲队", ownerEmail: "owner@test" });
const a1 = fleetDb.createMember({ id: "m_a1", fleetId: A.id, title: "简报岗", targetKind: "persona", targetId: "policy-brief" });
const a2 = fleetDb.createMember({ id: "m_a2", fleetId: A.id, title: "审核岗", targetKind: "persona", targetId: "auditor" });
fleetDb.updateFleet(A.id, { orchestration: { edges: [{ kind: "handoff", from: a1.id, to: a2.id }] } });

const B = fleetDb.createFleet({ id: "fleet_fixture_b", name: "乙队", ownerEmail: "owner@test" });
fleetDb.createMember({ id: "m_b1", fleetId: B.id, title: "缺岗", targetKind: "persona", targetId: "gone-preset" });

const C = fleetDb.createFleet({ id: "fleet_fixture_c", name: "丙队", ownerEmail: "owner@test" });

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const u = req.headers["x-test-user"];
  if (u) req.user = { email: u, groups: [] };
  next();
});
createFleetRoutes(app, {
  authEnabled: false,
  cellUserEmail: "owner@test",
  // A deterministic resolver: the fixture's targets do not exist in any catalog,
  // and the branch under test is the VIEW's rendering of alive/dead, not the
  // resolver's own logic.
  fleetTargetResolver: (t) => ({
    alive: t?.targetId !== "gone-preset",
    label: t?.targetId ?? null,
    clusterName: null,
  }),
});
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

const call = async (method, p, body) => {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: { "content-type": "application/json", "x-test-user": "owner@test" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({ unparsable: true })) };
};

// ── The surface: reads (views) + writes (the two PATCH faces) ────────────────
const surface = {};
surface["GET /api/fleets"] = await call("GET", "/api/fleets");
for (const f of [A, B, C]) surface[`GET /api/fleets/${f.id}`] = await call("GET", `/api/fleets/${f.id}`);

// A member patch that exercises validation + the persisted shape.
surface["PATCH member (valid)"] = await call("PATCH", `/api/fleets/${A.id}/members/${a1.id}`, {
  title: "简报岗（改）",
  cadence: "0 9 * * *",
});
// The same patch rejecting bad input.
surface["PATCH member (invalid title)"] = await call("PATCH", `/api/fleets/${A.id}/members/${a1.id}`, {
  title: "",
});
surface["PATCH fleet (pause)"] = await call("PATCH", `/api/fleets/${C.id}`, { action: "pause" });
surface["PATCH fleet (bad action)"] = await call("PATCH", `/api/fleets/${C.id}`, { action: "reboot" });
surface["GET /api/fleets (after writes)"] = await call("GET", "/api/fleets");

server.close();
cron.shutdown?.();
fs.rmSync(tmpRoot, { recursive: true, force: true });

// ── Compare or capture ───────────────────────────────────────────────────────
if (CAPTURE) {
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  // Canonicalise before storing too: the baseline must be a shape, not an
  // accident of which fleet happened to sort first that run.
  fs.writeFileSync(BASELINE, JSON.stringify(canonical(surface), null, 2) + "\n");
  console.log(`[fleet-surface] captured ${Object.keys(surface).length} endpoints -> ${path.relative(REPO, BASELINE)}`);
  process.exit(0);
}

if (!fs.existsSync(BASELINE)) {
  console.error("[fleet-surface] no baseline — run with --capture first");
  process.exit(2);
}
const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
const failures = compareSurfaces(baseline, canonical(surface));
if (failures.length === 0) {
  console.log(`[fleet-surface] ✓ ${Object.keys(surface).length} endpoints byte-identical to the baseline`);
  process.exit(0);
}
console.error(`[fleet-surface] ✗ ${failures.length} difference(s) — the refactor changed observable behavior:`);
for (const f of failures.slice(0, 40)) console.error("  " + f);
if (failures.length > 40) console.error(`  … ${failures.length - 40} more`);
process.exit(1);
