// ── repair → ops → architect lane (openspec: fleet-ops-manager task 3.2) ─────
//
// The manager's whole write path is "render the repair diff into the EXISTING
// architect ops and send it through fleet_draft". If those rendered ops don't
// pass the real validateFleetDraft, the manager can propose repairs the lane
// rejects — a broken loop that only shows up in production. So this drives the
// REAL validator over a REAL fleet db, end to end:
//   live post → diagnosis(budget) → repairDraft → renderRepairOps → validateFleetDraft
//
//   node --test scripts/test-repair-ops-flow.mjs

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "repair-flow-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const chatHistory = await import("../chat-history.js");
const cron = await import("../cron.js");
const { initDb } = await import("../db.js");
const engine = await import("../task-engine.js");
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { validateFleetDraft, applyFleetDraft } = await import("../server/fleet-architect.js");
const { repairDraft, renderRepairOps } = await import("../lib/fleet-ops-manager.js");
const { diffTeamStructure, membersFromLive } = await import("../lib/team-structure.js");

await initDb();
await chatHistory.initChatHistory();
await engine.initTaskEngine({ broadcast: () => {}, runTurn: async () => ({ ok: true, text: "ok" }), isBusy: () => false });

after(async () => {
  cron.shutdown?.();
  await engine.idle?.();
  await new Promise((r) => setTimeout(r, 50));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

let fleetDb;
beforeEach(() => {
  fleetDb = createFleetDatabase({ file: path.join(tmpRoot, `fleets-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`) });
  setFleetDatabase(fleetDb);
});

const resolver = (m) => ({ alive: true, label: m.targetId, clusterName: null });

// Create a live fleet with one persona post that has a primary model, no fallback.
function seedFleetWithPost() {
  const draft = {
    mode: "create",
    fleet: { name: "运维验收队" },
    members: [{ op: "add", title: "分析师", targetKind: "persona", targetId: "persona-a", cadence: { cron: "0 * * * *", tz: null, promptTemplate: "报数" } }],
  };
  const v = validateFleetDraft(fleetDb, draft, { resolver });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  // Materialize the post via the db (the architect apply path needs an owner
  // session; here we only need the member row the repair reads).
  const fleetId = `fl_${Math.random().toString(36).slice(2, 8)}`;
  const fleet = fleetDb.createFleet({ id: fleetId, name: "运维验收队", ownerEmail: "owner@test" });
  fleetDb.createMember({
    id: `m_${Math.random().toString(36).slice(2, 8)}`,
    fleetId: fleet.id,
    title: "分析师",
    parentId: null,
    targetKind: "persona",
    targetId: "persona-a",
    kpiSlots: [],
    cadence: { cron: "0 * * * *", tz: null, promptTemplate: "报数" },
    model: "expensive-flash",
    fallbackModel: null,
  });
  return { fleet, members: fleetDb.listMembers(fleet.id) };
}

test("repair(ops) from a real live post passes the REAL validateFleetDraft", () => {
  const { fleet, members } = seedFleetWithPost();
  const live = members[0];

  // budget diagnosis on that live post; roster shows a healthy alternate.
  const repair = repairDraft({
    diagnoses: [{ ref: live.id, errorKind: "budget" }],
    liveRows: members,
    modelRoster: [
      { id: "expensive-flash", budgetRemainingPct: 4 },
      { id: "glm-cheap", budgetRemainingPct: 82 },
    ],
  });
  assert.equal(repair.ok, true, JSON.stringify(repair));
  assert.equal(repair.diff.updates.length, 1);

  // render the diff into the architect's ops shape and run the REAL validator.
  const rendered = renderRepairOps(repair.diff);
  assert.equal(rendered.ok, true);
  const check = validateFleetDraft(
    fleetDb,
    { mode: "edit", fleetId: fleet.id, members: rendered.members },
    { resolver },
  );
  assert.equal(check.ok, true, JSON.stringify(check.errors));
  // the rendered op is an update of the live post that only carries fallbackModel
  assert.deepEqual(rendered.members[0], { op: "update", ref: live.id, fallbackModel: "glm-cheap" });
});

test("repair with no healthy candidate renders NOTHING to send (evidence gap, not empty ops)", () => {
  const { members } = seedFleetWithPost();
  const repair = repairDraft({
    diagnoses: [{ ref: members[0].id, errorKind: "budget" }],
    liveRows: members,
    modelRoster: [{ id: "expensive-flash", budgetRemainingPct: 4 }],
  });
  assert.equal(repair.ok, false);
  // no diff to render at all
  assert.equal(repair.diff, undefined);
});

test("renderRepairOps refuses a diff that adds/removes posts (repairs never restructure)", () => {
  const out = renderRepairOps({ adds: [{ ref: "x" }], updates: [], removes: [] });
  assert.equal(out.ok, false);
  assert.match(out.reason, /never adds or removes/);
});

// ── 3.2b: the repair actually LANDS through the real apply path ──────────────

function budgetRepairOn(members) {
  const repair = repairDraft({
    diagnoses: [{ ref: members[0].id, errorKind: "budget" }],
    liveRows: members,
    modelRoster: [
      { id: "expensive-flash", budgetRemainingPct: 4 },
      { id: "glm-cheap", budgetRemainingPct: 82 },
    ],
  });
  assert.equal(repair.ok, true, JSON.stringify(repair));
  return renderRepairOps(repair.diff);
}

test("未批准零落地: drafting/rendering writes nothing to the member row", () => {
  const { fleet, members } = seedFleetWithPost();
  budgetRepairOn(members); // repair decision + render only (no apply)
  // the member row is untouched — the manager holds no write until apply
  assert.equal(fleetDb.listMembers(fleet.id)[0].fallbackModel, null);
});

test("repair LANDS via the REAL applyFleetDraft (fallbackModel written to the row)", async () => {
  const { fleet, members } = seedFleetWithPost();
  const rendered = budgetRepairOn(members);
  const applied = await applyFleetDraft(
    fleetDb,
    { mode: "edit", fleetId: fleet.id, members: rendered.members },
    { ownerEmail: "owner@test", resolver },
  );
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(fleetDb.listMembers(fleet.id)[0].fallbackModel, "glm-cheap");
});

test("drift-deny: apply is refused at revalidation when the targeted post vanished", async () => {
  const { fleet, members } = seedFleetWithPost();
  const rendered = budgetRepairOn(members);
  fleetDb.deleteMember(members[0].id); // the post drifts away before apply
  const applied = await applyFleetDraft(
    fleetDb,
    { mode: "edit", fleetId: fleet.id, members: rendered.members },
    { ownerEmail: "owner@test", resolver },
  );
  assert.equal(applied.ok, false);
  assert.equal(applied.stage, "revalidation");
});

// ── 3.3 rollback: target the pre-repair structure and land it back via apply ──
//
// Rollback is NOT a manual row edit — it re-targets the pre-repair TeamStructure
// and rides the same diff→render→apply lane. This also probes a real null-vs-
// undefined question: can an update op CLEAR fallbackModel back to null, or does
// the apply path treat null as "keep current"? The assertion tells us the truth.
test("rollback: re-target pre-repair structure and land it back (member row restored)", async () => {
  const { fleet, members } = seedFleetWithPost();
  const original = membersFromLive(fleetDb.listMembers(fleet.id)); // pre-repair core

  // forward: repair + land
  const rendered = budgetRepairOn(members);
  const applied = await applyFleetDraft(
    fleetDb,
    { mode: "edit", fleetId: fleet.id, members: rendered.members },
    { ownerEmail: "owner@test", resolver },
  );
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(fleetDb.listMembers(fleet.id)[0].fallbackModel, "glm-cheap");

  // rollback: desired = the pre-repair structure, through the same lane
  const current = membersFromLive(fleetDb.listMembers(fleet.id));
  const backDiff = diffTeamStructure(current, original);
  const back = renderRepairOps(backDiff);
  assert.equal(back.ok, true, JSON.stringify(back));
  const reverted = await applyFleetDraft(
    fleetDb,
    { mode: "edit", fleetId: fleet.id, members: back.members },
    { ownerEmail: "owner@test", resolver },
  );
  assert.equal(reverted.ok, true, JSON.stringify(reverted));
  // the member row is back to its pre-repair state — no manual edit
  assert.equal(fleetDb.listMembers(fleet.id)[0].fallbackModel, null);
});
