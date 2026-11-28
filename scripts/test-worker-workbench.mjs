// ── Run workbench wiring tests (fleet-run-workbench §2 / §5.1,5.2,5.3,5.10) ──
//
// The primitive (lib/run-worktree.js) is tested on its own. This file pins the
// EXECUTION face — that the worker pool actually uses it the way the spec says:
//   • off           → byte-identical (no host call, child cwd untouched)
//   • auto          → one bench per run, the child switched onto it, same file
//                     name in two runs does not overwrite, the address lands on
//                     the run ledger
//   • create fails  → run settles interrupted naming the reason, never falls
//                     back to the shared directory
//   • release fails → the slot is still returned (cleanup never freezes a pool)
//
// Real engine, fake bridge + fake host: nothing here needs a cluster.
//
//   node --test scripts/test-worker-workbench.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "worker-wb-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.TASK_WORKER_MAX = "2";

const engine = await import("../task-engine.js");
const { attachWorkerPool } = await import("../server/worker-slots.js");

test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const DEPLOY_CWD = path.join(tmpRoot, "deploy-cwd");
fs.mkdirSync(DEPLOY_CWD, { recursive: true });

// A fake bridge that tracks its cwd and honours restart({cwd}) like DshBridge.
class CwdBridge {
  static all = [];
  static byPersona = new Map();
  constructor(params) {
    this.params = params;
    this.cwd = params.cwd ?? DEPLOY_CWD;
    this.prompts = [];
    this.restarts = [];
    CwdBridge.all.push(this);
    CwdBridge.byPersona.set(params.agentPreset, this);
  }
  async start() { this.ready = true; }
  isReady() { return this.ready; }
  get runtimeModel() { return this.params?.model ?? null; }
  get runtimeProvider() { return this.params?.provider ?? null; }
  getCwd() { return this.cwd; }
  async restart({ cwd } = {}) {
    this.restarts.push(cwd);
    if (cwd) this.cwd = cwd;
  }
  close() {}
  async prompt(sessionId, blocks) {
    this.prompts.push({ sessionId, blocks, cwd: this.cwd });
    this.emit({ method: "session.event", params: { event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "stub reply" }] } } } } });
    await new Promise((r) => { this.release = r; });
    this.emit({ method: "session.status", params: { status: "idle" } });
  }
  emit(notif) { this.params.onEvent(notif); }
}

// A fake host: acquire/create/release are recorded; the returned bench is a
// real directory under tmp so "write same file" genuinely overlaps.
function fakeHost({ failCreate = false, failRelease = false, usage = null } = {}) {
  const calls = { acquire: 0, release: 0 };
  const live = new Set();
  let seq = 0;
  return {
    calls,
    async acquire() {
      calls.acquire++;
      if (failCreate) { const e = new Error("工作台未建立: disk full"); e.code = "WORKBENCH_CREATE_FAILED"; throw e; }
      const cwd = path.join(tmpRoot, `bench-${++seq}`);
      fs.mkdirSync(cwd, { recursive: true });
      live.add(cwd);
      return { cwd, backend: "directory", workbenchRef: `bench-${seq}` };
    },
    async usage() {
      return usage ?? { bytes: 0, mb: 0, limitMb: null, over: false };
    },
    async changes(wb) {
      // Real shape: whatever the bench dir holds is the run's output.
      const files = [];
      for (const name of fs.readdirSync(wb.cwd)) files.push({ path: name, status: "A", added: 1, deleted: 0 });
      return { ok: true, backend: "directory", files, total: files.length, added: files.length, deleted: 0, coverage: "无 git：清单为工作台内的全部文件（本运行产出）" };
    },
    async release(wb) {
      calls.release++;
      live.delete(wb.cwd);
      if (failRelease) throw new Error("release blew up");
      return { removed: [wb.cwd], leftovers: [], deferred: false };
    },
  };
}

function makeCtx(recorded = []) {
  return {
    broadcast: () => {},
    sessionCollectors: new Map(),
    workerSpawnParams: { provider: "finddata", model: "stub", cwd: DEPLOY_CWD },
    recordFleetTurnEvent: (task, out, meta) => recorded.push({ task, out, meta }),
  };
}

async function bootEngine() {
  fs.writeFileSync(path.join(tmpRoot, "jobs.json"), "[]");
  await engine.initTaskEngine({
    broadcast: () => {},
    runTurn: async () => ({ ok: true }),
    isBusy: () => false,
  });
}

const settle = () => new Promise((r) => setTimeout(r, 40));

test.afterEach(() => {
  for (const b of CwdBridge.all) b.release?.();
  CwdBridge.all.length = 0;
  CwdBridge.byPersona.clear();
  engine.setSlotDispatcher(null);
});

test("5.1 off: no workbench call, child cwd stays the deployment dir", async () => {
  await bootEngine();
  const host = fakeHost();
  const ctx = makeCtx();
  ctx.runWorkbench = host;
  attachWorkerPool(ctx, { spawnBridge: (p) => new CwdBridge(p) });

  const t = engine.createManualTask({ prompt: "A", persona: "code", initiator: "s1" }); // workbench unset ⇒ off
  await settle();
  const b = CwdBridge.byPersona.get("code");
  assert.equal(host.calls.acquire, 0, "off must never ask the host for a bench");
  assert.equal(b.getCwd(), DEPLOY_CWD, "off keeps the deployment cwd byte-for-byte");
  assert.equal(b.restarts.length, 0, "off must not restart the child for a cwd switch");
  b.release();
  await settle();
  assert.equal(engine.getTask(t.id).state, "done");
});

test("5.2 auto: two runs get different benches and same-named writes do not collide", async () => {
  await bootEngine();
  const host = fakeHost();
  const recorded = [];
  const ctx = makeCtx(recorded);
  ctx.runWorkbench = host;
  attachWorkerPool(ctx, { spawnBridge: (p) => new CwdBridge(p) });

  const a = engine.createManualTask({ prompt: "A", persona: "code", initiator: "s1", workbench: "auto" });
  const b = engine.createManualTask({ prompt: "B", persona: "minimal", initiator: "s1", workbench: "auto" });
  await settle();
  await settle();

  const ba = CwdBridge.byPersona.get("code");
  const bb = CwdBridge.byPersona.get("minimal");
  assert.notEqual(ba.getCwd(), bb.getCwd(), "each run gets its own bench directory");
  assert.equal(host.calls.acquire, 2);

  // Prove isolation with a real same-named write in each bench.
  fs.writeFileSync(path.join(ba.getCwd(), "out.txt"), "from-A");
  fs.writeFileSync(path.join(bb.getCwd(), "out.txt"), "from-B");
  assert.equal(fs.readFileSync(path.join(ba.getCwd(), "out.txt"), "utf8"), "from-A");
  assert.equal(fs.readFileSync(path.join(bb.getCwd(), "out.txt"), "utf8"), "from-B");

  ba.release(); bb.release();
  await settle();
  assert.equal(engine.getTask(a.id).state, "done");
  assert.equal(engine.getTask(b.id).state, "done");
  // The run ledger carries the workbench address on the turn's detail.
  assert.ok(recorded.some((r) => r.out?.detail?.workbench?.cwd), "turn detail names the run's bench");
});

test("5.3 create fails: run settles interrupted, named, and does NOT fall back", async () => {
  await bootEngine();
  const host = fakeHost({ failCreate: true });
  const recorded = [];
  const ctx = makeCtx(recorded);
  ctx.runWorkbench = host;
  attachWorkerPool(ctx, { spawnBridge: (p) => new CwdBridge(p) });

  const t = engine.createManualTask({ prompt: "A", persona: "code", initiator: "s1", workbench: "auto" });
  await settle();
  await settle();
  const b = CwdBridge.byPersona.get("code");
  assert.equal(b.prompts.length, 0, "must not prompt after the bench failed to build");
  assert.equal(b.getCwd(), DEPLOY_CWD, "must not run in the shared directory");
  assert.match(recorded[0]?.out?.error ?? "", /工作台未建立/);
  assert.equal(recorded[0]?.out?.interrupted, true);
  const rec = engine.getTask(t.id);
  assert.equal(rec.state, "interrupted");
});

test("5.10 release fails: the slot is still returned", async () => {
  await bootEngine();
  const host = fakeHost({ failRelease: true });
  const ctx = makeCtx();
  ctx.runWorkbench = host;
  const pool = attachWorkerPool(ctx, { spawnBridge: (p) => new CwdBridge(p) });

  const a = engine.createManualTask({ prompt: "A", persona: "code", initiator: "s1", workbench: "auto" });
  await settle();
  CwdBridge.byPersona.get("code").release();
  await settle();
  assert.equal(engine.getTask(a.id).state, "done");
  assert.equal(host.calls.release, 1, "release was attempted");
  assert.equal(pool.poolStats().busy, 0, "a failed release must not hold the slot");
});

test("5.5 quota: a run over WORKBENCH_MAX_MB settles failed with the reading", async () => {
  await bootEngine();
  const host = fakeHost({ usage: { bytes: 3 * 1024 * 1024, mb: 3, limitMb: 1, over: true } });
  const recorded = [];
  const ctx = makeCtx(recorded);
  ctx.runWorkbench = host;
  attachWorkerPool(ctx, { spawnBridge: (p) => new CwdBridge(p) });

  const t = engine.createManualTask({ prompt: "A", persona: "code", initiator: "s1", workbench: "auto" });
  await settle();
  CwdBridge.byPersona.get("code").release();
  await settle();
  const rec = engine.getTask(t.id);
  assert.equal(rec.state, "failed", "an over-quota run is not a success");
  assert.match(recorded[0]?.out?.error ?? rec.error ?? "", /超配额/);
  assert.equal(recorded[0]?.out?.detail?.workbenchQuota?.mb, 3);
});

test("5.5 quota: under the limit still settles ok (no false failure)", async () => {
  await bootEngine();
  const host = fakeHost({ usage: { bytes: 1024, mb: 0.01, limitMb: 10, over: false } });
  const ctx = makeCtx();
  ctx.runWorkbench = host;
  attachWorkerPool(ctx, { spawnBridge: (p) => new CwdBridge(p) });

  const t = engine.createManualTask({ prompt: "A", persona: "code", initiator: "s1", workbench: "auto" });
  await settle();
  CwdBridge.byPersona.get("code").release();
  await settle();
  assert.equal(engine.getTask(t.id).state, "done");
});

test("3-rev the worker round stamps workbenchChanges onto the ledger detail", async () => {
  await bootEngine();
  const host = fakeHost();
  const recorded = [];
  const ctx = makeCtx(recorded);
  ctx.runWorkbench = host;
  attachWorkerPool(ctx, { spawnBridge: (p) => new CwdBridge(p) });

  const t = engine.createManualTask({ prompt: "A", persona: "code", initiator: "s1", workbench: "auto" });
  await settle();
  const b = CwdBridge.byPersona.get("code");
  // The run writes into its bench before the round settles.
  fs.writeFileSync(path.join(b.getCwd(), "artifact.txt"), "output");
  b.release();
  await settle();

  const rec = engine.getTask(t.id);
  assert.equal(rec.state, "done");
  const landed = recorded.find((r) => r.out?.detail?.workbenchChanges);
  assert.ok(landed, "the turn detail carries the per-run change list");
  assert.equal(landed.out.detail.workbenchChanges.files[0].path, "artifact.txt");
  assert.match(landed.out.detail.workbenchChanges.coverage, /无 git/);
});
