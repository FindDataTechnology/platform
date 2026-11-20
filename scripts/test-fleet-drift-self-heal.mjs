// e2e — fleet drift self-heal, the FULL dispatch path (fix-fleet-model-drift 4.2).
//
// Scenario the task pins: a dispatch round whose first attempt dies with a
// 400 model_not_available (the child's persisted selection drifted out-of-band)
// self-heals — the declared hop is force re-asserted, the turn runs a SECOND
// time and succeeds, detail.modelRectified lands, the trace header.model shows
// the declared model again, and the ledger stamps NO modelMismatch.
//
// Drives the real runPersonaTurn (the self-heal gate and retry live inside it)
// and the real ledger end (header-vs-ledger comparison) against a stub bridge.
// Regression guard for the dead-gate bug: normalizeModelForJob's return was
// missing explicitChain, so the gate could never open — a seam-level test
// cannot see that; only this path-level run can.
//
// Run: node --test scripts/test-fleet-drift-self-heal.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-drift-e2e-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
delete process.env.FLEET_MODEL_ASSERT_SOFT;
delete process.env.FLEET_TRACE_TAP;

const dbModule = await import("../db.js");
await dbModule.initDb();
await (await import("../chat-history.js")).initChatHistory();
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { fleetModelFor } = await import("../server/fleet-reports.js");
const { createFleetTurnLedger } = await import("../server/fleet-runs.js");
const { runPersonaTurn, roundChildSessionId, isModelUnavailableError } = await import("../server/cron-runner.js");

const DECLARED = "deepseek-v4.1-flash";
const DRIFTED = "qwen3.8-flash";

let fleetDb;
const fleetId = "f1";
const memberId = "m1";
const preset = "persona-x";

before(() => {
  fleetDb = createFleetDatabase({ file: path.join(tmpRoot, `fleets-${Date.now()}.db`) });
  setFleetDatabase(fleetDb);
  fleetDb.createFleet({ id: fleetId, name: "drift e2e fleet", ownerEmail: "o@x" });
  fleetDb.createMember({
    id: memberId,
    fleetId,
    title: "patrol",
    targetKind: "persona",
    targetId: preset,
    kpiSlots: [],
    cadence: { cron: "0 * * * *", tz: null, promptTemplate: "报数", enabled: true },
    model: DECLARED,
  });
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// In-memory trace store with the same record/getTurn surface the ledger tap
// and end() read (server/trace.js minus sqlite).
function makeTraceStore() {
  const events = [];
  let seq = 0;
  return {
    events,
    record(notif, { turnId }) {
      const eventType = notif.method === "platform/stream"
        ? "platform/stream"
        : notif.params?.event?.type ?? notif.method;
      events.push({
        seq: ++seq,
        ts: Date.now(),
        method: notif.method,
        eventType,
        turnId,
        payload: notif.params ?? null,
      });
    },
    getTurn(turnId) {
      const rows = events.filter((e) => e.turnId === turnId);
      return rows.length ? rows : null;
    },
  };
}

function makeCtx(_trace, childId) {
  const switchCalls = [];
  const promptCalls = [];
  const collectors = new Map();
  let promptCount = 0;
  const ctx = {
    sessionCollectors: collectors,
    onRuntimeIdle: () => {},
    isStreaming: false,
    sessionVersion: 1,
    broadcast: () => {},
    session: { model: { id: DECLARED } },
    dshModels: [{ id: DECLARED, provider: "deepseek" }],
    llmLaneForModel: () => null,
    recordFleetModelNotices: () => {},
    resolveFleetIdentity: null,
    // Real plan builder — the explicitChain verdict comes from the member's
    // declared model through the same resolution production uses.
    resolveFleetModel: async (p) => fleetModelFor(fleetDb, p, { roster: [DECLARED] }),
    switchModelTo: async (model, opts = {}) => {
      switchCalls.push({ model, force: opts.force === true });
      return { ok: true };
    },
    dshBridge: {
      isReady: () => true,
      hasLiveMethod: () => true,
      setPreset: async () => {},
      preparedPreset: () => undefined,
      deleteSession: async () => {},
      prompt: async (sessionId) => {
        promptCount += 1;
        promptCalls.push({ sessionId, n: promptCount });
        if (promptCount === 1) {
          // The drifted child refuses its out-of-band selection.
          throw new Error(`400 model_not_available: ${DRIFTED} is not available`);
        }
        const collect = collectors.get(childId);
        if (collect) {
          // Second attempt's request header: the runtime is back on the
          // declared model — this is what the trace stores and end() reads.
          collect({
            method: "session.event",
            params: { event: { type: "request/header", data: { header: { config: { provider: "deepseek", model: DECLARED } } } } },
          });
          collect({ method: "session.status", params: { status: "idle" } });
        }
      },
    },
  };
  return { ctx, switchCalls, promptCalls, childId };
}

test("drift self-heal e2e: 400 model_not_available → force re-assert → second attempt wins → modelRectified + header restored + no modelMismatch", async () => {
  const trace = makeTraceStore();
  const ledger = createFleetTurnLedger({
    db: fleetDb,
    broadcast: () => {},
    engineRecords: () => [],
    trace,
    rosterPresetId: (x) => x,
    now: () => Date.now(),
  });
  const startedAt = Date.now();
  const job = {
    id: "job_e2e_drift",
    sessionId: "cron-job_e2e_drift",
    targetType: "persona",
    preset,
    sourceTag: { fleetId, memberId },
    prompt: "巡视",
    executionCarrier: { carrier: "cell" },
    roundSeq: 1,
  };
  // The rotated child id must match runPersonaTurn's own derivation — the
  // collector is keyed by the id the child is prompted under.
  const childId = roundChildSessionId(job, startedAt, job.roundSeq);
  const { ctx, switchCalls, promptCalls } = makeCtx(trace, childId);
  const handle = ledger.begin(job, { startedAt, sessionIds: [childId] });
  assert.ok(handle?.traceTurnId, "ledger opened a trace turn for the fleet round");

  ctx.fleetTurnLedger = ledger;
  // server.js's recordFleetTurnEvent core: the wrapper hands the outcome and
  // the ledger handle here; end() runs the header-vs-ledger comparison.
  ctx.recordFleetTurnEvent = (job, outcome, meta) =>
    meta?.ledgerTurn ? ledger.end(job, meta.ledgerTurn, outcome, meta) : null;

  const out = await runPersonaTurn(ctx, job, 5_000, new Map(), { startedAt });

  // 1. The turn SUCCEEDED — via the second attempt, not the first.
  assert.equal(out.ok, true, `turn should self-heal to success, got: ${out.error}`);
  assert.equal(promptCalls.length, 2, "exactly two attempts (one failure, one healed retry)");
  assert.ok(isModelUnavailableError("400 model_not_available: x"), "sanity: signature matches");

  // 2. The self-heal stamped its mark.
  assert.equal(out.detail?.modelRectified, DECLARED, "detail.modelRectified carries the re-asserted model");

  // 3. Both switches were FORCED (normalize + self-heal re-assert) and the
  //    re-assert landed AFTER the failure.
  assert.ok(switchCalls.length >= 2, `expected normalize + rectify switches, got ${switchCalls.length}`);
  assert.deepEqual(switchCalls.map((c) => c.model), [DECLARED, DECLARED]);
  assert.equal(switchCalls[1].force, true, "self-heal re-asserts with force:true");

  // 4. Trace header.model restored to the declared model — the child's own
  //    request header is the ground truth the ledger compares against.
  const headerEvent = trace
    .getTurn(handle.traceTurnId)
    ?.find((t) => t.eventType === "request/header");
  assert.ok(headerEvent, "the healed attempt emitted a request/header trace event");
  assert.equal(
    headerEvent.payload?.event?.data?.header?.config?.model,
    DECLARED,
    "trace header.model shows the declared model after self-heal",
  );

  // 5. Ledger end: header and ledger agree → NO mismatch stamp; the
  //    modelRectified detail survives the row write.
  const row = await ledger.end(job, handle, out, {
    startedAt,
    endedAt: Date.now(),
    model: DECLARED,
  });
  assert.equal(row?.detail?.modelMismatch ?? null, null, "agreement stamps no modelMismatch");
  assert.equal(row?.detail?.modelRectified, DECLARED, "modelRectified survives on the ledger row");
});
