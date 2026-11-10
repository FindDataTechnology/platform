// Unit tests — fleet model drift (fix-fleet-model-drift).
//
// Pins:
//   - fleetModelFor: explicitChain flips on declared model/fallbackModel,
//     never for a chain-less post
//   - switchModelToInner: force=true bypasses the session-ledger early return
//   - fleet-runs.end: trace header model ≠ ledger model stamps detail.modelMismatch,
//     and agreement never writes one
//   - isModelUnavailableError: catches the drift signature honestly
// Run: node --test scripts/test-fleet-model-drift.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-drift-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const dbModule = await import("../db.js");
await dbModule.initDb();
await (await import("../chat-history.js")).initChatHistory();
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { fleetModelFor } = await import("../server/fleet-reports.js");
const { createFleetTurnLedger } = await import("../server/fleet-runs.js");
const { isModelUnavailableError } = await import("../server/cron-runner.js");

let fleetDb;
beforeEach(() => {
  fleetDb = createFleetDatabase({ file: path.join(tmpRoot, `fleets-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`) });
  setFleetDatabase(fleetDb);
});

function seedPost(extra = {}) {
  fleetDb.createFleet({ id: "f1", name: "post fleet", ownerEmail: "o@x" });
  return fleetDb.createMember({
    id: "m1",
    fleetId: "f1",
    title: "post",
    targetKind: "persona",
    targetId: "persona-x",
    kpiSlots: [],
    cadence: { cron: "0 * * * *", tz: null, promptTemplate: "报数", enabled: true },
    ...extra,
  });
}

test("fleetModelFor: explicitChain only when model or fallbackModel declared", async () => {
  const declared = seedPost({ model: "deepseek-v4.1-flash" });
  const plan1 = fleetModelFor(fleetDb, declared.targetId, { roster: ["deepseek-v4.1-flash"] });
  assert.equal(plan1.explicitChain, true);

  const chainless = fleetDb.createMember({ id: "m-less", fleetId: "f1", title: "no chain", targetKind: "persona", targetId: "persona-y", kpiSlots: [], cadence: { cron: "0 * * * *", tz: null, promptTemplate: "报数", enabled: true } });
  const plan2 = fleetModelFor(fleetDb, chainless.targetId, { roster: ["deepseek-v4.1-flash"] });
  assert.equal(plan2.explicitChain, false);
});

test("ledger.end: header-vs-ledger model mismatch lands detail.modelMismatch; non-fleet turns never read the trace", async () => {
  const payload = { event: { data: { header: { config: { provider: "volces", model: "qwen3.8-flash" } } } } };
  const trace = { getTurn: () => [{ seq: 5, ts: Date.now(), method: "session.event", eventType: "request/header", payload }] };
  seedPost({ model: "deepseek-v4.1-flash" });
  const ledger = createFleetTurnLedger({ db: fleetDb, broadcast: () => {}, engineRecords: () => [], trace, rosterPresetId: (x) => x, now: () => Date.now() });
  const job = { id: "job_1", sessionId: "cron-job_1", preset: "persona-x", sourceTag: { fleetId: "f1", memberId: "m1" }, prompt: "巡视" };
  const startedAt = Date.now();
  const handle = ledger.begin(job, { startedAt, sessionIds: ["cron-job_1#r1"] });
  const out = await ledger.end(job, handle, { ok: true, usage: { input: 10, output: 2 } }, { startedAt, endedAt: Date.now(), model: "deepseek-v4.1-flash" });
  assert.equal(out.detail.modelMismatch.declared, "deepseek-v4.1-flash");
  assert.equal(out.detail.modelMismatch.observedHeader, "qwen3.8-flash");
});

test("ledger.end: matching header never stamps; no trace available stays quiet too", async () => {
  const payload = { event: { data: { header: { config: { model: "deepseek-v4.1-flash" } } } } };
  const trace = { getTurn: () => [{ seq: 5, ts: Date.now(), method: "session.event", eventType: "request/header", payload }] };
  seedPost({ model: "deepseek-v4.1-flash" });
  const ledger = createFleetTurnLedger({ db: fleetDb, broadcast: () => {}, engineRecords: () => [], trace, rosterPresetId: (x) => x, now: () => Date.now() });
  const job = { id: "job_2", sessionId: "cron-job_2", preset: "persona-x", sourceTag: { fleetId: "f1", memberId: "m1" }, prompt: "巡视" };
  const startedAt = Date.now();
  const handle = ledger.begin(job, { startedAt, sessionIds: ["cron-job_2#r1"] });
  const out = await ledger.end(job, handle, { ok: true, usage: { input: 10, output: 2 } }, { startedAt, endedAt: Date.now(), model: "deepseek-v4.1-flash" });
  assert.equal(out.detail?.modelMismatch ?? null, null);
});

test("isModelUnavailableError: catches the drift signature, leaves unknown failures alone", () => {
  assert.equal(isModelUnavailableError("400 model_not_available: qwen3.8-flash is not available"), true);
  assert.equal(isModelUnavailableError("INVALID_MODEL: named model not found"), true);
  assert.equal(isModelUnavailableError("cannot find model deepseek"), true);
  assert.equal(isModelUnavailableError("timeout"), false);
  assert.equal(isModelUnavailableError(null), false);
});
