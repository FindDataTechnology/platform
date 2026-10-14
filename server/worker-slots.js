// ── Worker pool ──────────────────────────────────────────────────────────────
//
// The task-worker slots (spec: worker-pool; ADR 0005): on-demand DshBridge
// instances, each pinned to ONE persona for its life, executing task-engine
// dispatches in parallel while the primary runtime serves the conversation.
//
// Design D1: a worker is the primary's bridge construction with a different
// agentPreset and a worker-local event pump — same composed profile (home,
// patches, credentials, HMR), no parallel bootstrap path. Outputs isolate by
// session id (every task runs in its own dedicated session).
//
// The engine's slot dispatcher (setSlotDispatcher) hands due executions here
// when the pool is active (TASK_WORKER_MAX > 0); at cap 0 the pool never
// registers and the engine's serial primary chain is exactly today's
// behavior. Tasks that find no slot (cap reached) queue FIFO until a worker
// frees; spawn failures fall back to the primary chain.

import { DshBridge } from "../dsh-bridge.js";
import * as engine from "../task-engine.js";
import * as chatHistory from "../chat-history.js";
import { collectTurn } from "./cron-runner.js";

const REAP_SCAN_MS = 60_000;
const IDLE_REAP_MS = 5 * 60_000;

// DshBridge's lifecycle end is the async shutdown() (the SDK's EOF→SIGTERM→
// SIGKILL ladder); test fakes expose a sync close(). Calling close?.() on a
// real bridge was a silent no-op that leaked the worker's dsh child.
function stopBridge(bridge) {
  try {
    if (typeof bridge?.shutdown === "function") {
      bridge.shutdown()?.catch?.(() => {});
    } else {
      bridge?.close?.();
    }
  } catch { /* best-effort */ }
}

function readCap() {
  const raw = process.env.TASK_WORKER_MAX;
  const n = Number(raw);
  if (raw === undefined || raw === "") return 0;
  if (!Number.isInteger(n) || n < 0) {
    console.warn(`[worker-pool] TASK_WORKER_MAX=${raw} is invalid; falling back to 0 (serial mode)`);
    return 0;
  }
  return n;
}

// attachWorkerPool(ctx, opts): inert unless cap > 0. ctx.workerSpawnParams
// carries the primary bridge's construction inputs (stashed in server.js).
// opts.spawnBridge/opts.idleReapMs exist for tests (fake bridges, fast reap).
export function attachWorkerPool(ctx, { spawnBridge = null, idleReapMs = IDLE_REAP_MS } = {}) {
  const cap = readCap();
  if (cap <= 0) {
    ctx.workerPool = null;
    return { cap: 0, drain: async () => {}, shutdown: () => {} };
  }
  console.log(`[worker-pool] active, TASK_WORKER_MAX=${cap}`);

  const workers = new Set(); // { id, persona, bridge, busy, collectors, activeTurns, lastUsedAt, inFlight }
  const waiting = []; // task ids FIFO, pool-owned queue
  let workerSeq = 0;
  let reapTimer = null;

  const emitPoolState = () => {
    ctx.broadcast?.({
      type: "worker_pool",
      workers: [...workers].map((w) => ({ persona: w.persona, state: w.busy ? "busy" : "idle" })),
    });
  };

  // ── Worker-local event pump (design D3): collector routing ONLY — no web
  // broadcast, no trace, no agent-change translation. A bridge exit aborts
  // this worker's in-flight collector (interrupted, not failed).
  function pumpFor(worker) {
    return (notif) => {
      const { method } = notif || {};
      if (method === "bridge.exit" || method === "_bridge_crash") {
        const abort = worker.activeTurns.get(worker.currentSession);
        if (abort) abort("the worker runtime restarted mid-turn");
        return;
      }
      const collector = worker.collectors.get(worker.currentSession);
      collector?.(notif);
    };
  }

  async function spawnWorker(persona) {
    const construct = spawnBridge || ((params) => new DshBridge(params));
    const worker = {
      id: `worker-${++workerSeq}`,
      persona,
      busy: false,
      currentSession: null,
      collectors: new Map(),
      activeTurns: new Map(),
      lastUsedAt: Date.now(),
      inFlight: null,
    };
    worker.bridge = construct({
      ...ctx.workerSpawnParams,
      agentPreset: persona,
      onEvent: pumpFor(worker),
    });
    await worker.bridge.start();
    workers.add(worker);
    console.log(`[worker-pool] spawned ${worker.id} for persona ${persona}`);
    emitPoolState();
    return worker;
  }

  // One task turn on a worker: the cron-runner contract minus the preset
  // switch (the worker IS its persona) and minus the primary bridge.
  async function runOnWorker(worker, task, { turnTimeoutMs }) {
    const sessionId = task.sessionId;
    worker.currentSession = sessionId;
    worker.lastUsedAt = Date.now();
    chatHistory.recordMessage(sessionId, "user", task.prompt);
    if (task.sessionTitle) {
      try {
        chatHistory.setTitle(sessionId, task.sessionTitle);
      } catch { /* sanitize failure leaves the prompt-derived title */ }
    }
    const collected = collectTurn(ctx, sessionId, turnTimeoutMs, worker.activeTurns, worker.collectors);
    let result;
    try {
      await worker.bridge.prompt(sessionId, [{ type: "text", text: task.prompt }]);
      result = await collected;
    } catch (e) {
      worker.collectors.delete(sessionId);
      worker.activeTurns.delete(sessionId);
      return { ok: false, error: e?.message || String(e), interrupted: e?.interrupted === true };
    } finally {
      worker.currentSession = null;
    }
    if (result.error) return { ok: false, error: result.error };
    return { ok: true, usage: result.usage ?? null };
  }

  // Run one queued task id on a worker slot, then service the wait queue.
  async function runTaskOn(worker, id) {
    worker.busy = true;
    emitPoolState();
    try {
      await engine.beginExecution(id, (task, opts) => runOnWorker(worker, task, opts));
    } finally {
      worker.busy = false;
      worker.lastUsedAt = Date.now();
      emitPoolState();
      scheduleNext();
    }
  }

  // Assign waiting tasks to idle workers (persona affinity), spawning while
  // under cap. `spawning` counts in-flight spawn()s SYNCHRONOUSLY — the cap
  // check must hold before the async spawn lands the worker in the set, or
  // two simultaneous due tasks both see room for themselves.
  let spawning = 0;
  function scheduleNext() {
    while (waiting.length) {
      const idx = waiting.findIndex((id) => {
        const t = engine.getRecord(id);
        if (!t || t.paused || t.status === "expired" || t.status === "completed") return false;
        const persona = t.preset;
        if (!persona) return false;
        if ([...workers].some((w) => !w.busy && w.persona === persona)) return true;
        return workers.size + spawning < cap;
      });
      if (idx === -1) return;
      const id = waiting.splice(idx, 1)[0];
      const task = engine.getRecord(id);
      if (!task) continue;
      const persona = task.preset;
      const idle = [...workers].find((w) => !w.busy && w.persona === persona);
      if (idle) {
        void runTaskOn(idle, id);
        continue;
      }
      spawning++;
      spawnWorker(persona)
        .then((w) => {
          spawning--;
          return runTaskOn(w, id);
        })
        .catch((err) => {
          spawning--;
          console.error(`[worker-pool] spawn for ${persona} failed: ${err.message}; task ${id} falls back to the primary slot`);
          engine.runOnPrimary(id);
        });
    }
  }

  // The engine's slot dispatcher: claim persona-targeted executions whenever
  // the pool can serve them now or soon; anything else goes to the primary.
  function dispatcher(task) {
    if (!task) return false;
    if (task.trigger !== "manual" && task.trigger !== "schedule") return false;
    // a2a targets are remote turns (add-agent-delegation-a2a) — no persona to
    // pin; they ride the primary chain's remote executor.
    if (task.targetType === "a2a") return false;
    // Null-ref (legacy live-preset) tasks have no persona to pin a worker to.
    if (!task.preset) return false;
    waiting.push(task.id);
    scheduleNext();
    return true;
  }

  reapTimer = setInterval(() => {
    let changed = false;
    for (const w of [...workers]) {
      if (w.busy) continue;
      if (Date.now() - w.lastUsedAt > idleReapMs) {
        workers.delete(w);
        changed = true;
        stopBridge(w.bridge);
        console.log(`[worker-pool] reaped ${w.id} (persona ${w.persona}, idle)`);
      }
    }
    if (changed) emitPoolState();
  }, Math.min(REAP_SCAN_MS, Math.max(200, idleReapMs)));
  reapTimer.unref?.();

  engine.setSlotDispatcher(dispatcher);

  return {
    cap,
    drain: async () => {
      // Aggregator gate (design D4): wait out every in-flight worker turn.
      while ([...workers].some((w) => w.busy)) {
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    shutdown: () => {
      if (reapTimer) clearInterval(reapTimer);
      for (const w of workers) stopBridge(w.bridge);
      workers.clear();
    },
  };
}
