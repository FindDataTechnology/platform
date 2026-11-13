// ── Task engine ───────────────────────────────────────────────────────────────
//
// The unified in-cell task engine (add-task-engine; ADR 0006): one task
// concept for all unattended agent work. A task carries a target (the persona
// that executes it), a prompt, a dedicated session, and a trigger; scheduling
// is one trigger kind and lives in cron.js — this module owns task records,
// the execution lifecycle (queued → running → done | failed | interrupted),
// the serialized execution queue, restart repair, and the task event surface.
//
// Execution runs on execution slots (ADR 0005); the primary slot is the only
// one today and is the cron-runner turn flow, injected as `runTurn`. Worker
// slots (change ③) will add executors without touching the task model here.

import fs from "node:fs";
import path from "node:path";
import { storeDir } from "./paths.js";
import cronParser from "cron-parser";
import { atomicWriteJson, readJsonOr, createWriteChain } from "./lib/persistence.js";

const TASK_STORAGE_DIR = storeDir("cron-store", process.env.CRON_STORAGE_PATH);
const JOBS_FILE = path.join(TASK_STORAGE_DIR, "jobs.json");

// Same file, same ids as the pre-engine cron store — records gain fields,
// nothing moves (design D1: one store, extended in place).
//
// fix-fleet-turn-budget D1: this is a FALLBACK, not the budget. The engine used
// to hand every turn this constant, which silently overrode the declarable
// budgets downstream (`cron-runner.js` computed `turnTimeoutMs || resolveTurnBudgetMs(job)`
// — left side always non-empty, so the resolver never ran). The scheduler now
// injects `resolveTurnBudget` and the engine asks for the number; the constant
// only serves hosts that inject nothing (their behavior stays as it was).
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const HISTORY_LIMIT = 100;
// a2a targets (market Agent Services) are supported when the cell's catalog
// holds online a2a entries — executed as remote turns (add-agent-delegation-a2a).
const SUPPORTED_TARGET_TYPES = ["persona", "a2a", "cluster", "tool"];
const SUPPORTED_TRIGGERS = ["schedule", "manual"];

let tasks = new Map(); // id -> task record (loaded from disk + live schedule
// handle on .job owned by cron.js)
let broadcastFn = null;
let runTurnFn = null;
// Readiness gate: routes are mounted before initTaskEngine runs (it waits on
// the boot Promise.all), so a task created-and-run on a COLD cell could reach
// the chain with no turn executor ("turnFn is not a function", prod 2026-10-21)
// and an insert could land in the pre-init map that init then replaces.
let initialized = false;
let isBusyFn = null;
// Worker-pool occupancy provider (unify-wanxing-management-plane): injected by
// the server layer so the stats snapshot can speak for slots this module does
// not own. Read lazily at snapshot time — the pool attaches after init.
let workerStatsFn = null;
// The scheduling front-end refreshes nextRun; the delegation aggregator arms
// summary injections. Multiple subscribers, order-independent, each guarded.
const onFinishedHooks = new Set();
// The scheduling front-end's last chance to shape a prompt before the turn
// runs (fix-fleet-context-injection-seam). Injected once by initTaskEngine and
// awaited in runExecutionTurn — the ONE point every enqueue path converges on,
// which is why the seam lives here rather than at the enqueue sites that used
// to arm prompt overrides (two of which had already been missed: manual
// run-now, and the boot-time repair queue). The engine knows nothing about
// fleets; it only offers a seam.
let beforeTurnFn = null;
// fix-fleet-turn-budget D1: the scheduler injects how long this task may run.
// The engine asks instead of deciding — a constant here overrode every
// declarable budget (cadence.turnTimeoutMs, constraints.budgetPerEdgeMin)
// without any of them ever being read. Null → the fallback constant, which
// keeps hosts that inject nothing byte-for-byte as before.
let resolveTurnBudgetFn = null;
let executionQueue = Promise.resolve();
// Progress evidence for the readiness probe (fix-queue-degraded-vs-busy): a
// backlog is not a stall. Live 2026-11-09: a fleet cell sat 60-67 minutes deep
// while turns settled every 4-5 minutes and four of five succeeded — yet
// /api/ready answered 503 because the OLDEST waiting item was older than the
// threshold. Busy and stuck are different states and must read differently.
let lastSettledAt = 0;
const repairQueue = []; // ids persisted as queued at load → re-enqueue after init

// Executions waiting for the primary slot's serial chain, oldest first. The
// chain is a promise tail, so anything already chained can never be reordered
// — hence the drain chains only the execution about to run and picks it from
// this list at that moment (fix-main-chain-human-priority).
const pendingExecutions = [];
let executionDraining = false;
// The execution spliced off the queue and about to start (see drainExecutions).
let inFlightExecutionId = null;
// Orphan debounce (fix-orphaned-queued-executions): enqueue→dispatch is not
// synchronous, so a task can briefly read `queued` with no pending execution and
// would otherwise be counted (and reported) as an orphan for that instant. Only a
// task seen off-chain on TWO consecutive evaluations is treated as orphaned —
// that is drift, not a dispatch in flight.
let orphanCandidates = new Set();

// ── Cron session rotation (rotate-cron-session-on-context-pressure) ─────────
//
// A cron task keeps ONE session forever (`cron-<id>`), so every round appends
// its full conversation — including tool results — and the cached context only
// grows. Live 2026-11-09, the optimizer's inventory post:
//
//   cacheRead 84,480 → 119,168 → 157,824   (window = 128,000)
//   output tokens 564 → 805 → 128
//
// The last round's output collapsed to exactly 128 tokens — the same number a
// completely different post produced — because the window had ~128 tokens
// left. Two unrelated posts reporting the identical output size is the
// fingerprint: it is the window, not the prompt.
//
// So the session is rotated once it approaches the window. The ratio is
// configurable because the right number depends on the model; 0.7 leaves room
// for one long round on top of the accumulated history.
const SESSION_ROTATE_RATIO = Number(process.env.CRON_SESSION_ROTATE_RATIO || 0.7);
const SESSION_CONTEXT_WINDOW = Number(process.env.CRON_CONTEXT_WINDOW || 128_000);

// Pure predicate (exported for tests): does the most recent metered round put
// this task's session at/over the rotate threshold? Only the newest metered
// entry counts — an old spike that a rotation already cleared must not rotate
// again forever.
// 上下文溢出（rotate-cron-session-on-context-pressure 的盲点修复）。
//
// 为什么需要它：`shouldRotateSession` 只从历史行的 `tokens` 取数，而**把窗口跑爆
// 的那一轮恰恰不会留下 tokens**（2026-11-09 实测：该类行 tokens=0）。于是判据对
// "刚刚溢出的那一刻"失明——如果溢出前那条还在阈值之下（比如一条超长 tool result
// 直接把上下文顶过去），下一轮就不会轮换，再溢一次。
//
// 判据来自 provider 的文案（`@deepseek-ai/dsh-llm` 的 isContextWindowExceededError
// 就是从 detail 里识别，不是本地预检），所以我们只需识别它已经识别过的那几种措辞。
const CONTEXT_OVERFLOW_RE = /CONTEXT_WINDOW_EXCEEDED|context overflow|context window exceeded|maximum context length|too large for (?:this|the) model/i;

export function isContextOverflowError(text) {
  return CONTEXT_OVERFLOW_RE.test(String(text || ""));
}

export function shouldRotateSession(
  history = [],
  { window = SESSION_CONTEXT_WINDOW, ratio = SESSION_ROTATE_RATIO } = {},
) {
  if (!Array.isArray(history) || history.length === 0) return false;
  if (!Number.isFinite(window) || window <= 0) return false;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const tokens = history[i]?.tokens;
    if (!tokens) continue;
    const cache = Number(tokens.cacheReadTokens) || 0;
    const input = Number(tokens.inputTokens) || 0;
    const used = cache + input;
    if (used <= 0) return false;
    return used >= window * ratio;
  }
  return false;
}

// Mint the next session id. Derived from the task id (never from the previous
// sessionId) so repeated rotations cannot grow a suffix chain.
function nextCronSessionId(taskId) {
  return `cron-${taskId}--r${Date.now()}`;
}

// ── Persistence ─────────────────────────────────────────────────────────────

// Serialized + atomic persistence: mutations rewrite the whole tasks file, so
// overlapping saves are queued (no lost update) and each write goes through a
// unique temp file (no interleaved-write corruption).
const writeChain = createWriteChain();
/**
 * Resolves once every task write queued SO FAR has landed. It does NOT queue a
 * write of its own — that distinction is the point: a test can wait for the
 * producer's persistence instead of racing it, and still fails if the producer
 * never issued a save. (Replaces a 10s poll a loaded 2-core runner blew through,
 * 2026-11-13.)
 */
function whenTasksPersisted() {
  return writeChain.whenDrained();
}

function saveTasks() {
  return writeChain.mutate(async () => {
    // Serialize only the task data (excluding the live node-schedule handle).
    // Computed inside the queued task so a later save always sees the latest
    // in-memory state.
    const serializable = [...tasks.values()].map((t) => ({
      id: t.id,
      trigger: t.trigger ?? "schedule",
      type: t.type,
      cron: t.cron,
      when: t.when,
      // Schedule-form extras (add-cron-automation-parity): the interval rule,
      // its anchor, and the finite-run counter pair. Absent on legacy records.
      ...(t.interval ? { interval: t.interval, anchor: t.anchor ?? null } : {}),
      ...(t.maxRuns != null ? { maxRuns: t.maxRuns, runs: t.runs ?? 0 } : {}),
      prompt: t.prompt,
      preset: t.preset ?? null,
      targetType: t.targetType ?? "persona",
      // Turn carrier (add-fleet-carrier): the placement config persists with
      // the task (contrast: executionCarrier stays transient — that one is the
      // ACTUAL body, this one is the CONFIGURED wish).
      carrier: t.carrier ?? null,
      packId: t.packId ?? null,
      // Turn metering (add-turn-metering): the enqueue stamp survives a restart
      // so a queued-across-boot task still reports its true wait. executionCarrier
      // stays transient (re-derived at enqueue — restart re-queues nothing in
      // flight).
      queuedAt: t.queuedAt ?? null,
      // Staleness anchor (fix-cell-turn-throughput 2.3): `queuedAt` is re-stamped
      // on every re-enqueue and again by drainRepairQueue at boot, so it can only
      // measure the current attempt. `firstQueuedAt` is the clock that survives —
      // without persisting it, a restart made the whole catch-up wave look brand
      // new and the age policy could never fire (live 2026-11-08: 18 queued
      // executions, all stamped within a second of boot).
      firstQueuedAt: t.firstQueuedAt ?? null,
      // Requestor of the current queue residence (see enqueueExecution): the
      // age policy must survive a restart knowing a human asked for the round.
      queuedBy: t.queuedBy ?? null,
      // Cluster binding (agent-cluster-platform): persisted alongside the ref
      // in `preset` — without these a cell restart reloaded cluster tasks with
      // their policy/subset/label gone (prod 2026-10-21: list showed null,
      // re-runs silently fell back to all-members/sequential).
      ...(t.targetType === "cluster"
        ? {
            clusterId: t.clusterId ?? null,
            clusterName: t.clusterName ?? null,
            agentCount: t.agentCount ?? null,
            executionPolicy: t.executionPolicy ?? null,
            targetAgents: t.targetAgents ?? null,
          }
        : {}),
      sessionId: t.sessionId ?? null,
      sessionTitle: t.sessionTitle ?? null,
      tz: t.tz ?? null,
      status: t.status,
      state: t.state ?? null,
      error: t.error ?? null,
      initiator: t.initiator ?? null,
      initiatorPreset: t.initiatorPreset ?? null,
      initiatorGroup: t.initiatorGroup ?? null,
      origin: t.origin ?? null,
      // Human-priority wake (add-turn-mandate-lane): stamped by the human
      // seams (owner execute-now actions); the worker pool's extra slot
      // serves these. Event/cron/delegation tasks never carry it.
      humanPriority: t.humanPriority === true,
      // Owning front-end tag (agent-fleet-core: { fleetId, memberId }). An
      // opaque passthrough on every surface — the engine never interprets it;
      // the fleet reconcile layer locates its materialized tasks by it.
      sourceTag: t.sourceTag ?? null,
      // 顶替留痕（3.1）：被谁顶掉的，事后可查。
      supersededBy: t.supersededBy ?? null,
      // 岗位级豁免（3.1）：该岗位的排队轮不参与顶替。
      noSupersede: t.noSupersede === true,
      // Project attribution (add-web-project-container): cron jobs live in this
      // file store rather than SQLite, so the optional project id rides the
      // record itself. Absent/NULL = the 默认项目 bucket (legacy + desktop).
      // The engine never interprets it — list filtering is the read surface's
      // job, exactly like sourceTag.
      projectId: t.projectId ?? null,
      aggregated: t.aggregated ?? false,
      paused: t.paused,
      // Pause SOURCE (fix-fleet-operator-pause-durability): "operator" vs
      // "fleet". Persisted for the same reason as lastMissedCountedUntil — the
      // fleet converge pass judges on it, so an unpersisted value would let a
      // restart turn an owner's stop back into "the fleet's to undo".
      pausedBy: t.pausedBy ?? null,
      createdAt: t.createdAt,
      lastRun: t.lastRun,
      nextRun: t.nextRun,
      missed: t.missed ?? 0,
      // 停机缺口水位（2026-11-09）：不持久化它，重启后同一批触发点会被重复计数。
      lastMissedCountedUntil: t.lastMissedCountedUntil ?? null,
      // 溢出后"下一轮必换会话"的标记：必须持久化，否则重启就把这个决定丢了
      // （与 lastMissedCountedUntil 同一条纪律：内存里有、盘上没有＝重启后行为漂移）。
      rotateNextSession: t.rotateNextSession === true,
      history: t.history,
    }));
    await atomicWriteJson(JOBS_FILE, serializable);
  });
}

// Derive the execution state a legacy record (pre-engine, no `state` field)
// implies from its history, so the UI can offer re-run on old failures.
function deriveLegacyState(record) {
  const last = Array.isArray(record.history) ? record.history[record.history.length - 1] : null;
  if (!last) return null;
  if (last.success === true) return "done";
  if (last.success === false) return "failed";
  return null;
}

// Load-time backfill + repair. Backfill: legacy records gain trigger/target
// fields and a stable session id. Repair: `running` becomes `interrupted`
// (never re-executed), `queued` is collected for re-enqueue after the
// scheduling front-end initializes.
function loadTasks() {
  repairQueue.length = 0;
  const saved = readJsonOr(JOBS_FILE, [], { label: "task-engine" });
  if (!Array.isArray(saved)) return false;
  let dirty = false;
  for (const data of saved) {
    const t = { missed: 0, state: null, error: null, ...data };
    if (!t.trigger) {
      t.trigger = "schedule";
      dirty = true;
    }
    if (!t.targetType) {
      t.targetType = "persona";
      dirty = true;
    }
    if (!t.sessionId) {
      // Backfill: mint the dedicated session id legacy records never had, so
      // the binding is stable across restarts from the first reload on.
      t.sessionId = `cron-${t.id}`;
      dirty = true;
    }
    if (!t.state) {
      // Legacy record: status was never persisted mid-run (no save between
      // "running" and completion), so a stray one is treated as interrupted;
      // otherwise the last history outcome decides.
      if (t.status === "running") {
        t.state = "interrupted";
        t.error = "cell restarted during execution";
      } else {
        t.state = deriveLegacyState(t);
      }
      dirty = true;
    } else if (t.state === "running") {
      t.state = "interrupted";
      t.error = "cell restarted during execution";
      dirty = true;
    }
    if (t.pausedBy === undefined) {
      // Legacy record (fix-fleet-operator-pause-durability): the field arrived
      // with the operator/fleet split. Interpreting a missing value as "fleet"
      // keeps pre-upgrade behaviour — a record paused before the split stays
      // resumable by the converge pass, whereas defaulting to "operator" would
      // silently freeze a whole class of parked posts. Only a paused record
      // needs the marker; a running one carries null.
      t.pausedBy = t.paused ? "fleet" : null;
      dirty = true;
    }
    if (t.state === "queued") {
      repairQueue.push(t.id);
    }
    tasks.set(t.id, { ...t, job: null });
  }
  console.log(`[task-engine] Loaded ${tasks.size} task(s) from storage`);
  return dirty;
}

// ── Initialization ──────────────────────────────────────────────────────────

async function initTaskEngine({ broadcast, runTurn, isBusy, onFinished, workerStats, beforeTurn, resolveTurnBudget }) {
  broadcastFn = broadcast;
  runTurnFn = runTurn;
  isBusyFn = isBusy;
  workerStatsFn = typeof workerStats === "function" ? workerStats : null;
  beforeTurnFn = typeof beforeTurn === "function" ? beforeTurn : null;
  resolveTurnBudgetFn = typeof resolveTurnBudget === "function" ? resolveTurnBudget : null;
  onFinishedHooks.clear();
  if (onFinished) onFinishedHooks.add(onFinished);
  // A fresh engine has settled nothing yet: the readiness projection must not
  // inherit progress evidence from a previous generation (tests re-init in one
  // process; a real cell boots one engine per process, so this is a no-op there).
  lastSettledAt = 0;
  // A fresh init replaces the in-memory map — any pending retry backoff from
  // the previous generation is stale (the reloaded records carry no attempt
  // state) and must not fire into the new one.
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
  tasks = new Map();

  await fs.promises.mkdir(TASK_STORAGE_DIR, { recursive: true });
  // Load-time mutations (backfill, repair) must reach disk before boot
  // completes, or the next restart re-repairs the same records.
  if (loadTasks()) await saveTasks();
  initialized = true;
  // Staleness sweep (fix-queue-staleness-sweep): the dequeue-time check only
  // fires for the fire that WINS the slot, so an over-age cadence fire parked
  // behind a stream of human/manual work is never looked at — and it holds the
  // queue-liveness probe degraded (503) while it waits. Unref'd: never keeps the
  // process alive.
  if (!staleSweepTimer) {
    staleSweepTimer = setInterval(() => {
      try {
        sweepStaleQueuedFires();
      } catch (e) {
        console.warn(`[task-engine] staleness sweep failed: ${e?.message || e}`);
      }
    }, STALE_SWEEP_INTERVAL_MS);
    staleSweepTimer.unref?.();
  }
}

// After the scheduling front-end has initialized (timers armed, expiry
// marked), re-enqueue executions that were persisted as queued at load.
// These bypass enqueueExecution's already-queued guard — their `queued` state
// IS the persisted flag, no live execution is chained — and go straight onto
// the queue; runQueuedExecution re-checks every guard before running.
function drainRepairQueue() {
  // Replay in WAITING order, not file order (harden-fleet-tool-face-and-queue
  // 2.4). `repairQueue` is rebuilt at load from the persisted order, so a task
  // that had been waiting for hours landed behind tasks queued minutes ago
  // every time the platform restarted — and this platform restarted ~8 times in
  // one day (2026-11-09 live: a human-exempt fire sat `queued` for 1.5 h while
  // later arrivals kept overtaking it). `firstQueuedAt` is the per-residence
  // anchor that boot does NOT re-stamp, so sorting on it preserves the real
  // waiting order across restarts.
  const replay = repairQueue.splice(0);
  replay.sort((a, b) => {
    const ta = tasks.get(a), tb = tasks.get(b);
    const ka = Number.isFinite(ta?.firstQueuedAt) ? ta.firstQueuedAt : (Number.isFinite(ta?.queuedAt) ? ta.queuedAt : 0);
    const kb = Number.isFinite(tb?.firstQueuedAt) ? tb.firstQueuedAt : (Number.isFinite(tb?.queuedAt) ? tb.queuedAt : 0);
    return ka - kb;
  });
  for (const id of replay) {
    const t = tasks.get(id);
    if (!t || scheduleSideBlocked(t)) {
      if (t) {
        t.state = null;
        releaseCatchUpMarker(t);
        void saveTasks();
      }
      continue;
    }
    // Re-stamp the wait clock (fix-task-queue-deadlock, found in live
    // observation): the persisted `queuedAt` predates the downtime, so a task
    // queued the evening before a restart reports "waiting 12 hours" the
    // morning after and the probe cries degraded on every boot. The wait that
    // matters started now, not when the previous process died.
    t.queuedAt = Date.now();
    void saveTasks();
    // Ownership: a replayed execution is the SAME work a fresh fire would be,
    // so it must go through the same dispatch seam. Calling chainExecution
    // here instead put every post-restart replay on the primary serial chain
    // and hid them from the worker pool entirely (2026-11-08 live: cell with
    // TASK_WORKER_MAX=2 logged `worker-pool active` but never spawned, while
    // 17+ replayed catch-ups queued ahead of fresh triggers — the fresh ones
    // then aged out at QUEUE_MAX_AGE_MS and were DROPPED, not delayed).
    // dispatch() asks the slot dispatcher first (worker claim) and falls back
    // to chainExecution, so nothing changes when no pool is configured.
    dispatch(id);
  }
}

// ── Task records ────────────────────────────────────────────────────────────

function getRecord(id) {
  return tasks.get(id) ?? null;
}

function allRecords() {
  return [...tasks.values()];
}

function isInitialized() {
  return initialized;
}

function insertTask(record) {
  if (!initialized) throw new Error("task engine is still starting — retry in a moment");
  if (!record?.id) throw new Error("task id is required");
  if (!record.prompt || typeof record.prompt !== "string") throw new Error("prompt is required");
  const trigger = record.trigger ?? "schedule";
  if (!SUPPORTED_TRIGGERS.includes(trigger)) {
    throw new Error(`unsupported trigger: ${trigger}`);
  }
  const type = record.targetType ?? "persona";
  if (!SUPPORTED_TARGET_TYPES.includes(type)) {
    throw new Error(`unsupported target type: ${type}`);
  }
  // A persona task MAY carry a null ref — legacy semantics: it runs under
  // whatever preset is live when it fires (cron-module's original behavior).
  tasks.set(record.id, { trigger, targetType: type, state: null, error: null, missed: 0, history: [], ...record, job: null });
  return tasks.get(record.id);
}

// Manual trigger (delegation front-end, or the MC bridge): create and
// immediately enqueue — no schedule is attached, so no schedule-side
// lifecycle ever applies. `origin` tags the creating front-end (e.g.
// { mc: <consoleTaskId> }) and persists with the record.
function createManualTask({ prompt, persona, agent, tool, sessionTitle, initiator, initiatorPreset, initiatorGroup, origin, executionPolicy = null, carrier = null, packId = null, humanPriority = false }) {
  if (!prompt || typeof prompt !== "string") throw new Error("prompt is required");
  const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  // Exactly one target flavor: a cell persona, a market a2a agent, or a tool
  // post's server::tool target (add-tool-posts). The delegation front-end
  // validates the ref against its universe beforehand.
  const targetCount = [persona, agent, tool].filter(Boolean).length;
  if (targetCount > 1) throw new Error("a task targets a persona OR a market agent OR a tool, not several");
  insertTask({
    id,
    trigger: "manual",
    type: "manual",
    cron: null,
    when: null,
    prompt,
    preset: persona ?? agent ?? tool ?? null,
    targetType: agent ? "a2a" : tool ? "tool" : "persona",
    carrier: carrier ?? null,
    packId: packId ?? null,
    sessionId: `task-${id}`,
    sessionTitle: sessionTitle || null,
    tz: null,
    status: "manual",
    paused: false,
    // Per-hop timeout budget (agent-fleet-orchestration handoff edges); null
    // = the deployment's default turn timeout.
    executionPolicy: executionPolicy && Number.isFinite(executionPolicy.timeoutMinutes) && executionPolicy.timeoutMinutes > 0
      ? { timeoutMinutes: executionPolicy.timeoutMinutes }
      : null,
    createdAt: new Date().toISOString(),
    lastRun: null,
    nextRun: null,
    // The conversation session that delegated this task — the aggregator's
    // fan-out bookkeeping key (persisted; restart-safe). initiatorPreset is
    // the persona the conversation ran under (the aggregator restores it).
    initiator: initiator ?? null,
    initiatorPreset: initiatorPreset ?? null,
    // Aggregation group (fix-fanout-aggregation D2): one ignition wave = one
    // group. `initiator` alone merges every wave the same session ever fired
    // into a single summary; absent (legacy rows, web-lane delegation) falls
    // back to grouping by initiator, which is the pre-change behavior.
    initiatorGroup: initiatorGroup ?? null,
    // Origin chain (dispatch/handoff/fanout) rides the task so the fleet
    // admission gate can count per-fleet in-flight (add-fleet-carrier D4).
    sourceTag: origin?.fleet?.fleetId ? { fleetId: origin.fleet.fleetId, memberId: origin.fleet.memberId ?? null } : null,
    // Creating front-end tag (the MC bridge's idempotency key); persisted,
    // never exposed on the wire.
    origin: origin ?? null,
    // Human-priority wake (add-turn-mandate-lane): the worker pool's extra
    // slot serves these; absent (false) is every pre-existing lane.
    humanPriority: humanPriority === true,
  });
  const enq = enqueueExecution(id);
  if (!enq.ok) throw new Error(enq.error);
  return getTask(id);
}

function deleteRecord(id) {
  clearRetryTimer(id);
  return tasks.delete(id);
}

function clientShape(t) {
  return {
    id: t.id,
    trigger: t.trigger ?? "schedule",
    type: t.type,
    cron: t.cron,
    when: t.when,
    // Schedule-form extras — present only on interval / capped tasks.
    ...(t.interval ? { interval: t.interval, anchor: t.anchor ?? null } : {}),
    ...(t.maxRuns != null ? { maxRuns: t.maxRuns, runs: t.runs ?? 0 } : {}),
    prompt: t.prompt,
    target: { type: t.targetType ?? "persona", ref: t.preset ?? null },
    preset: t.preset ?? null,
    // Cluster binding (agent-cluster-platform): present only on cluster tasks
    // — the human label/count ride the record so list views and the cron MCP
    // can describe the target without re-reading clusters.db.
    clusterId: t.clusterId ?? null,
    clusterName: t.clusterName ?? null,
    agentCount: t.agentCount ?? null,
    executionPolicy: t.executionPolicy ?? null,
    targetAgents: t.targetAgents ?? null,
    sessionId: t.sessionId ?? null,
    sessionTitle: t.sessionTitle ?? null,
    tz: t.tz ?? null,
    status: t.status,
    state: t.state ?? null,
    error: t.error ?? null,
    // Delegation bookkeeping (manual trigger): the session that delegated this
    // task and whether its outcome has already been summarized into one.
    initiator: t.initiator ?? null,
    aggregated: t.aggregated ?? false,
    // Owning front-end tag (agent-fleet-core) — passthrough, see saveTasks.
    sourceTag: t.sourceTag ?? null,
    // Project attribution (add-web-project-container) — passthrough; NULL =
    // the 默认项目 bucket. Read surfaces filter on it; the engine does not.
    projectId: t.projectId ?? null,
    paused: t.paused,
    // Pause source rides the client shape too (fix-fleet-operator-pause-durability):
    // the fleet reconcile reads jobs through this projection, so without it the
    // "operator" marker would be invisible exactly where it is judged.
    pausedBy: t.pausedBy ?? null,
    createdAt: t.createdAt,
    lastRun: t.lastRun,
    nextRun: t.nextRun,
    // Downtime accounting (P2, 2026-10-26): the counter alone stayed in logs
    // nobody reads — the reason and timestamp ride the task so cockpit and
    // post cards can say "skipped N rounds: platform was down".
    missed: t.missed ?? 0,
    lastMissedAt: t.lastMissedAt ?? null,
    // 已统计到哪（水位）：有了它，"这个计数是否被重复累加"可以自查。
    lastMissedCountedUntil: t.lastMissedCountedUntil ?? null,
    lastMissedReason: t.lastMissedReason ?? null,
    catchUpPending: t.catchUpPending === true,
    history: t.history.slice(-20), // Last 20 executions
  };
}

function listTasks() {
  return allRecords().map(clientShape);
}

function getTask(id) {
  const t = tasks.get(id);
  return t ? clientShape(t) : null;
}

// The RAW record — origin/executionPolicy ride turns internally (the wire
// view strips them by design). Consumers: the loopback bridges and tests
// that need to assert evidence (agent-fleet-orchestration dispatch/handoff).
function getTaskRecord(id) {
  return tasks.get(id) ?? null;
}

// ── Execution lifecycle ─────────────────────────────────────────────────────

function scheduleSideBlocked(t) {
  return Boolean(t.paused || t.status === "expired" || t.status === "completed");
}

// An execution attempt ended WITHOUT running (schedule-side blocked at one of
// the re-check points). Release the make-up marker (fix-fleet-context-
// injection-seam): the flag now drives the 【补跑】 prompt prefix in the seam,
// so if it outlived the fire it marked, the NEXT normal fire would wear a
// false make-up label. Dropped = not a make-up round.
function releaseCatchUpMarker(t) {
  if (t && t.catchUpPending === true) {
    t.catchUpPending = false;
    void saveTasks();
  }
}

// ── Failure retry policy (harden-cell-execution-reliability) ────────────────
//
// A failed execution MAY re-execute automatically: env-configured, OFF by
// default (the fail-fast status quo is untouched unless enabled), exponential
// backoff, bounded attempt count. Misconfiguration fails closed to the
// default — no retry — a typo'd knob must never invent executions. Per-kind
// override: PLATFORM_TASK_RETRY_MAX_TARGET_<TYPE> (persona/a2a/cluster/tool)
// raises, lowers or disables the ceiling for that target class.
//
// A retry re-enters through the ORDINARY enqueue path (guards re-run there:
// schedule-side blocked, already queued/running), and any fresh execution —
// schedule fire, run-now, re-run — supersedes a pending retry: the backoff
// timer is cancelled and the attempt cycle restarts at 1. Timers are
// in-process only: a restart drops the pending backoff, the record stays
// failed (human-visible, manually re-runnable) and the next execution starts
// a fresh cycle.
const RETRY_MAX_ENV = "PLATFORM_TASK_RETRY_MAX";
const RETRY_BACKOFF_ENV = "PLATFORM_TASK_RETRY_BACKOFF_MS";
const DEFAULT_RETRY_BACKOFF_MS = 60_000;
// setTimeout loses precision past 2^31 ms (a too-large delay fires early);
// the cap keeps every backoff inside timer territory and bounds one wait to
// a day.
const RETRY_DELAY_CAP_MS = 24 * 60 * 60 * 1000;

// Which failures may be retried at all (harden-fleet-tool-face-and-queue 3.4 /
// ledger E26). Live 2026-11-09: four DIFFERENT failures — an upstream 502
// (`llm/retry` exhausted 5 attempts), a real context overflow, a model budget
// exhaustion, and `runtime not ready` after a rollout — all surfaced through
// the same "context overflow" wording, and because the retry policy defaulted
// to zero every one of them retired the round permanently. Only the transient
// shapes below deserve another attempt: retrying a context overflow burns the
// same window again, and retrying a budget exhaustion is pure waste.
const TRANSIENT_FAILURE_RE = new RegExp(
  [
    "upstream service temporarily unavailable",
    "\\b50[234]\\b",
    "\\b429\\b",
    "rate.?limit",
    "timed out|timeout",
    "econn[a-z]+|socket hang up|network|fetch failed|other side closed",
    "runtime is not ready",
    "upstream_error",
  ].join("|"),
  "i",
);

// A failure the engine may retry on its own. Pure predicate — the caller
// already decided that `max` allows it.
function isTransientFailure(error) {
  if (!error) return false;
  const text = String(error);
  return TRANSIENT_FAILURE_RE.test(text);
}
const warnedRetryEnvs = new Set();

function warnBadRetryEnv(name, value) {
  const key = `${name}=${value}`;
  if (warnedRetryEnvs.has(key)) return;
  warnedRetryEnvs.add(key);
  console.warn(`[task-engine] invalid ${name}='${value}' — retry policy fails closed to the default (no retry)`);
}

// Resolve the policy for one failed execution. Read per failure (not cached at
// boot) so an operator can turn retries on without a restart.
function resolveRetryPolicy(targetType) {
  let broken = false;
  let max = 0;
  const rawMax = process.env[RETRY_MAX_ENV];
  if (rawMax != null && rawMax !== "") {
    const parsed = Number(rawMax);
    if (Number.isInteger(parsed) && parsed >= 0) max = parsed;
    else {
      warnBadRetryEnv(RETRY_MAX_ENV, rawMax);
      broken = true;
    }
  }
  const overrideEnv = `${RETRY_MAX_ENV}_TARGET_${String(targetType ?? "").toUpperCase()}`;
  const rawOverride = process.env[overrideEnv];
  if (rawOverride != null && rawOverride !== "") {
    const parsed = Number(rawOverride);
    if (Number.isInteger(parsed) && parsed >= 0) max = parsed;
    else {
      warnBadRetryEnv(overrideEnv, rawOverride);
      broken = true;
    }
  }
  let backoffMs = DEFAULT_RETRY_BACKOFF_MS;
  const rawBackoff = process.env[RETRY_BACKOFF_ENV];
  if (rawBackoff != null && rawBackoff !== "") {
    const parsed = Number(rawBackoff);
    if (Number.isFinite(parsed) && parsed > 0) backoffMs = parsed;
    else {
      warnBadRetryEnv(RETRY_BACKOFF_ENV, rawBackoff);
      broken = true;
    }
  }
  // Fail closed: ANY misconfigured knob retires the whole policy for this
  // resolution — the default is no retry, never an invented one.
  if (broken) return { max: 0, backoffMs: DEFAULT_RETRY_BACKOFF_MS };
  return { max, backoffMs };
}

// Pending backoff timers, keyed by task id. Cancelled by the next fresh
// enqueue, by deletion, and by shutdown — a retry never outlives a decision
// a human (or the schedule) made afterwards.
const retryTimers = new Map(); // id -> NodeJS timeout

function clearRetryTimer(id) {
  const timer = retryTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    retryTimers.delete(id);
  }
}

// Schedule the next attempt of a failed execution after its backoff. The wait
// is exponential in the attempt just failed: attempt 1 → backoffMs, attempt 2
// → 2×, attempt 3 → 4× (capped). The re-entry carries its attempt stamp so
// the engine counts toward the ceiling.
function scheduleRetry(t, failedAttempt, policy) {
  clearRetryTimer(t.id);
  const delay = Math.min(policy.backoffMs * 2 ** (failedAttempt - 1), RETRY_DELAY_CAP_MS);
  const nextAttempt = failedAttempt + 1;
  console.log(`[task-engine] Task ${t.id} failed (attempt ${failedAttempt}) — retry #${nextAttempt} in ${delay}ms`);
  const timer = setTimeout(() => {
    retryTimers.delete(t.id);
    enqueueExecution(t.id, { retry: true, attempt: nextAttempt });
  }, delay);
  retryTimers.set(t.id, timer);
}

// Enqueue one execution of a task (schedule fire, run-now, re-run, or repair).
// Guards: schedule-side states that must not run are rejected; an execution
// already queued or running is a no-op returning the current state (re-run
// must not double-queue).
function enqueueExecution(id, opts = {}) {
  if (!initialized) return { ok: false, error: "task engine is still starting — retry in a moment" };
  const t = tasks.get(id);
  if (!t) return { ok: false, error: "task not found" };
  if (scheduleSideBlocked(t)) {
    // Rejected without ever enqueuing: the make-up marker must not survive to
    // label the next normal fire (fix-fleet-context-injection-seam).
    releaseCatchUpMarker(t);
    return { ok: false, error: `task is ${t.paused ? "paused" : t.status}` };
  }
  // 同岗位顶替（默认关闭）：必须在"本次入队"之前执行，新轮才能排到旧轮前面。
  const supersededIds = supersedeQueuedForPost(t);
  if (supersededIds.length) {
    console.warn(`[task-engine] ${t.id} superseded ${supersededIds.length} queued round(s) for the same post`);
    void saveTasks();
  }
  if (t.state === "queued" || t.state === "running") {
    // fix-task-queue-deadlock D4: this used to answer a bare {ok:true,
    // already:true}, which read exactly like a successful enqueue. On
    // 2026-11-08 that is what hid a wedged queue — every manual `run` looked
    // fine while the task had been parked for hours. Carry the state AND how
    // long it has waited so the caller can tell "just queued" from "been
    // sitting there since 00:34".
    //
    // An operator's run-now on a task that is ALREADY queued must still count
    // as an operator's ignition (harden-fleet-tool-face-and-queue 2.1): the
    // staleness policy only exempts `queuedBy === "human"`, and that stamp is
    // written once per queue residence. Live 2026-11-09: `POST
    // /api/cron/:id/run` answered `{ok:true, already:true, queuedForMs:481625}`
    // and left `queuedBy` null, so the operator's request inherited the cadence
    // fire's staleness and sat one bound away from being dropped. Upgrading the
    // stamp deliberately does NOT move the entry or touch `firstQueuedAt`: the
    // wait that already happened is real.
    let upgraded = false;
    if (opts.by === "human" && t.state === "queued" && t.queuedBy !== "human") {
      t.queuedBy = "human";
      t.history ||= [];
      const anchor = queueAnchorMs(t);
      t.history.push({
        kind: HISTORY_KIND.QUEUED_UPGRADE,
        time: new Date().toISOString(),
        duration: 0,
        state: "queued",
        success: null,
        error: null,
        note: "run-now on an already-queued fire: staleness exemption upgraded to human",
        waitedMs: anchor === null ? null : Math.max(0, Date.now() - anchor),
      });
      void saveTasks();
      upgraded = true;
    }
    // Orphan heal (fix-orphaned-queued-executions). "Already queued" used to be
    // returned unconditionally, which assumed the task is still ON the serial
    // chain. It need not be: a task can carry state="queued" while sitting in no
    // pending execution at all, and then `drainExecutions` has nothing to pick —
    // the whole queue stops with running=0, no error, and every later enqueue is
    // absorbed by this very branch. Live 2026-11-09 (cell 1da519d4c1c0bf89):
    // `queue.queued = 4`, `queue.running = 0`, `fairness` pending = 0 for ~20
    // minutes; a `run now` answered `already: true` and changed nothing.
    // "Already queued" must therefore mean "already on the chain".
    const onChain = t.state === "running" || inFlightExecutionId === id || pendingExecutions.some((e) => e.id === id);
    if (!onChain) {
      console.warn(`[task-engine] ${id} is queued but off the chain — re-dispatching`);
      dispatch(id);
    }
    return {
      ok: true,
      already: true,
      ...(upgraded ? { upgraded: true } : {}),
      ...(onChain ? {} : { requeued: true }),
      state: t.state,
      queuedForMs: (() => {
        const anchor = queueAnchorMs(t);
        return anchor === null ? null : Math.max(0, Date.now() - anchor);
      })(),
    };
  }
  // Mandate revalidation (add-turn-mandate-lane): a mandate-carrying task
  // re-executing revalidates FIRST — a failed check refuses the resume
  // (honest error, the gate records the disposition). Tasks without a
  // mandate are untouched; a broken gate fails open (legacy tolerance).
  if (t.origin?.mandate && mandateGateFn) {
    let verdict = null;
    try {
      verdict = mandateGateFn(t);
    } catch { /* fail open */ }
    if (verdict && verdict.ok === false) {
      return { ok: false, error: `mandate revoked: ${verdict.reason ?? "revalidation failed"}`, mandateRevoked: true };
    }
  }
  // Attempt bookkeeping: an automatic retry re-enters with its stamped
  // attempt; any fresh execution (schedule fire, run-now, re-run) starts a
  // new cycle at 1 and supersedes a pending automatic retry.
  if (opts.retry === true) {
    t.attempt = Number.isInteger(opts.attempt) && opts.attempt >= 1 ? opts.attempt : 1;
  } else {
    clearRetryTimer(id);
    t.attempt = 1;
  }
  t.state = "queued";
  // Turn metering (add-turn-metering D1/D3): the enqueue stamp feeds
  // queue_wait_ms (dequeue time − this). One stamp point — run-now and cron
  // due fires both pass through here, so primary and worker slots measure the
  // same queue. Re-enqueue re-stamps (a spent stamp must never measure a
  // previous execution's wait).
  t.queuedAt = Date.now();
  // Staleness anchor (fix-cell-turn-throughput 2.2 follow-up). `queuedAt` is a
  // WAIT clock and is deliberately re-stamped on every re-enqueue and on boot
  // (see drainRepairQueue), so it can never answer "how long has this fire been
  // trying to run". Live 2026-11-08: after each restart the catch-up wave was
  // re-stamped to "now", so 17 backlogged fires all looked brand new and the
  // staleness policy never fired while a `run now` waited behind them.
  // `firstQueuedAt` is stamped ONCE per queue residence and cleared when the
  // execution leaves the queue, so age means "since this fire first asked for a
  // slot".
  if (!Number.isFinite(t.firstQueuedAt)) {
    t.firstQueuedAt = t.queuedAt;
    // Who asked for this queue residence. `trigger` cannot answer it: `run now`
    // on a cadence task keeps trigger="schedule", so an operator's own ignition
    // was being aged out as a stale cadence fire once it waited past the bound
    // behind the cell's single slot — the exact "run-now lost" symptom this
    // change set out to kill. The age policy may only drop a fire nobody asked
    // for.
    t.queuedBy = opts.by === "human" ? "human" : "cadence";
  }
  // The execution carrier default: structural routing knowledge, not an
  // inference — a2a targets run on the primary's remote executor, everything
  // else starts as the primary-chain cell slot. A worker claim (worker-slots
  // markExecutionCarrier) overrides before beginExecution; the executor may
  // not invent other values.
  t.executionCarrier = t.targetType === "a2a" ? { carrier: "remote", instance: null } : { carrier: "cell", instance: null };
  void saveTasks();
  broadcastStatus(id);
  dispatch(id);
  return { ok: true, state: "queued" };
}

// Slot dispatch (ADR 0005): the worker pool, when active, claims executions
// it can run on a persona-bound worker; everything else runs on the primary
// slot's serial chain. The dispatcher returns true when it CLAIMED the
// execution (including queueing it for a future slot).
let slotDispatcherFn = null;
function setSlotDispatcher(fn) {
  slotDispatcherFn = typeof fn === "function" ? fn : null;
}

// Mandate revalidation gate (add-turn-mandate-lane): a task carrying an
// immutable mandate (origin.mandate, the event-wake lane) revalidates it
// against the CURRENT signal-source policy before an execution re-arms. The
// gate is wired by server.js (it owns the fleet db + the policy reader);
// unset = no mandates exist anywhere, zero disturbance. Refusal shape:
// { ok: false, reason } — the gate records the honest disposition row.
let mandateGateFn = null;
function setMandateGate(fn) {
  mandateGateFn = typeof fn === "function" ? fn : null;
}
function dispatch(id) {
  if (slotDispatcherFn) {
    let claimed = false;
    try {
      claimed = slotDispatcherFn(tasks.get(id), { runOnPrimary: () => chainExecution(id) }) === true;
    } catch {
      claimed = false;
    }
    if (claimed) return;
  }
  chainExecution(id);
}

// Chain one execution onto the serialized queue (no guards — callers either
// passed them or want the run-time re-check to decide).
//
// Queue watchdog (fix-cell-turn-throughput 2.1): the chain is strictly serial,
// so a turn that never settles stops EVERY queued execution behind it. Live
// 2026-11-08: a turn sat in `running` for 3.5 minutes with 24 tasks queued and
// nothing moved; `finishExecution` can only be called by the turn itself, so a
// turn wedged inside an `await` never reaches it.
//
// The deadline is therefore OUTSIDE the turn, where it cannot be defeated by a
// turn that fails to return. On expiry the task is settled through the same
// `finishExecution` path (so history/state semantics stay in one place) and the
// chained promise resolves, letting the queue advance.
const QUEUE_WATCHDOG_GRACE_MS = 5 * 60_000;

// Queue staleness bound (fix-cell-turn-throughput 2.2). The cell executes on ONE
// serial slot, so a burst of cadence fires (a restart's catch-up wave) can build
// an hours-long backlog; a scheduled fire that finally reaches the front hours
// later would run a patrol for a slot that has long passed while newer fires
// wait behind it. Above this age a scheduled fire is dropped as `skipped`
// without spending budget; the next cadence fire supersedes it. Env override
// `QUEUE_MAX_AGE_MS`; 0 disables the policy (pre-2.2 behaviour).
const QUEUE_MAX_AGE_MS_DEFAULT = 30 * 60_000;
// How often the sweep looks for over-age cadence fires the dequeue path cannot
// see: they never reach the front while human wakes and manual turns keep
// arriving, and while they wait they hold `queueHealth().degraded` true (which
// makes /api/ready answer 503 on a healthy cell).
const STALE_SWEEP_INTERVAL_MS = Number(process.env.QUEUE_STALE_SWEEP_MS) || 60_000;
let staleSweepTimer = null;

// 真实等待起点：`queuedAt` 每次重新入队与每次启动 drain 都会被重打（那是"本次尝试"
// 的等待时钟），`firstQueuedAt` 才是"这发请求第一次要槽位"的时刻、且跨重启存活。
// 任何对外暴露"等了多久"的地方都必须用它，否则重启后积压会显示成刚入队——
// 而 `/api/ready` 的 degraded 判定与 fleet-cost-digest 的承载提议都吃这个数。
// 同岗位排队顶替（harden-fleet-execution-economics 3.1）。**默认关闭**。
//
// 要解决的问题：舰队接棒/集群派发是 `trigger=manual`，而老化策略只对
// `trigger=schedule` 生效（manual 是"人真的要求了这一轮"，不能按时间丢）。
// 结果是接棒链可以无限堆积——实测 2026-11-08 owner cell：13 个 queued 里 12 个是
// manual 接棒，最老跨度 3.7 小时，新触发排在过期轮次后面。
//
// 处置不是"丢弃"而是"顶替"：同一岗位又有新一轮入队时，把**尚未开始的旧轮**
// 标记为 superseded（留痕 + 指向新轮），让新轮直接排到队头附近。
// 为什么可以顶替：接棒轮的语义是"把上游结果往下传"，中间轮传递的是更旧的上游
// 状态，最新一轮覆盖它不会丢结论——但**会丢中间轮的产出**，所以：
//   * 默认关闭（`QUEUE_SUPERSEDE_MANUAL=1` 才开）；
//   * 岗位可在 manifest 用 `noSupersede: true` 显式豁免；
//   * 被顶替的轮次进 history 且带 `supersededBy`，事后可查。
function supersedeManualEnabled() {
  const raw = process.env.QUEUE_SUPERSEDE_MANUAL;
  return String(raw ?? "").trim() === "1" || String(raw ?? "").toLowerCase() === "true";
}

// "同岗位"的判定键：同一舰队 + 同一岗位成员 + 同一 preset。
// 只用 preset 会把不同舰队的同名岗位混在一起；只用 fleetId 会把一个舰队的
// 全部岗位当成一个岗——两者都不对。
function postKey(t) {
  if (!t) return null;
  const member = t.sourceTag?.memberId ?? t.origin?.fleet?.memberId ?? null;
  const fleet = t.sourceTag?.fleetId ?? t.origin?.fleet?.fleetId ?? null;
  const preset = t.preset ?? null;
  if (!fleet && !preset) return null;          // 无可归属 → 永不顶替
  return [fleet ?? "-", member ?? "-", preset ?? "-"].join("|");
}

// 把同一岗位上尚未开始的 manual 轮标为 superseded，返回被顶替的 id 列表。
// 只在 enqueueExecution 里、新轮入队**之前**调用。
function supersedeQueuedForPost(t) {
  if (!supersedeManualEnabled()) return [];
  if (t?.trigger !== "manual") return [];
  if (t?.noSupersede === true) return [];
  const key = postKey(t);
  if (!key) return [];
  const superseded = [];
  for (const other of tasks.values()) {
    if (other.id === t.id) continue;
    if (other.state !== "queued") continue;      // 只有"还没开始"的能被顶替
    if (other.trigger !== "manual") continue;
    if (other.noSupersede === true) continue;
    if (other.queuedBy === "human") continue;    // 人点的那一轮不顶
    if (postKey(other) !== key) continue;
    other.state = "skipped";
    other.error = `superseded by ${t.id}: a newer round for the same post was enqueued while this one had not started`;
    other.supersededBy = t.id;
    other.firstQueuedAt = null;
    other.queuedAt = null;
    other.lastRun = other.lastRun ?? null;
    other.history ||= [];
    other.history.push({
      kind: HISTORY_KIND.SUPERSEDED,
      time: new Date().toISOString(),
      duration: 0,
      state: "skipped",
      success: false,
      error: other.error,
      supersededBy: t.id,
    });
    superseded.push(other.id);
  }
  return superseded;
}

// ── history 条目的类型（harden-fleet-execution-economics 1.4）────────────
//
// 为什么需要显式类型：同一天里，同一个形状 (`success: null`) 被我误读成"失败"三次——
//   ① `{success:null, missed:1}` 是**到期没跑**（不是失败）；
//   ② `{success:null, note:"…"}` 是**元数据行**（状态升级/校准留痕，不是一次执行）；
//   ③ 真失败是 `{success:false, state:"failed"}`。
// 统计脚本各自写 `cls()` 猜，于是每猜一次就错一次。类型必须由**写入方**声明，
// 读方按 `kind` 分流；旧数据没有 `kind` 时按形状回退推断（见 classifyHistoryEntry）。
// history[] 的分类与汇总住在 server/history-kinds.js：那个模块是纯函数
// （不碰 fs/时钟/引擎），报表脚本可以直接给生产记录分类而不必加载引擎。
// 这里 import 进来再原样导出，in-cell 调用方的入口不变。
import {
  HISTORY_KIND,
  classifyHistoryEntry,
  summarizeHistory,
} from "./server/history-kinds.js";

function queueAnchorMs(t) {
  if (!t) return null;
  if (Number.isFinite(t.firstQueuedAt)) return t.firstQueuedAt;
  if (Number.isFinite(t.queuedAt)) return t.queuedAt;
  return null;
}

function queueMaxAgeMs() {
  const raw = process.env.QUEUE_MAX_AGE_MS;
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n;
  }
  return QUEUE_MAX_AGE_MS_DEFAULT;
}

// One staleness decision, two callers (fix-queue-staleness-sweep).
//
// The bound used to be enforced ONLY on the dequeue path, which quietly made it
// a property of "reaching the slot" instead of "waiting too long". Live
// 2026-11-09: `job_1793413192186_g51s7b` (a cadence fire) sat queued 80 minutes
// — human wakes and manual turns kept jumping ahead, so it never reached the
// front and was never dropped. Worse, it kept `queueHealth().degraded` true,
// which makes `/api/ready` answer 503 forever on a healthy cell.
//
// Period awareness (fix-stale-drop-respects-period): the bound alone treats
// "waited 10 minutes" as "the round is worthless", but that is only true when
// another occurrence is coming soon. Dropping a DAILY round discards the whole
// day: `skipped` neither retries nor counts as `missed`, and the error text
// ("the next cadence fire supersedes it") is simply false for it. So a round
// whose period exceeds the bound is exempt — dropping must always have a
// successor inside the window.
const INTERVAL_UNIT_MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 };

// The task's cadence period in ms, or null when it cannot be established.
//
// Cron form is resolved through the same parser the scheduler itself uses
// (cron-parser, the one cron.js fires with) instead of being declared
// unknowable. The earlier "task-engine has no cron parser, so return null"
// position was self-defeating: every fleet post's cadence IS a cron
// expression, so the exemption above never applied to the rounds it was
// written for. Measured 2026-11-13: a DAILY brief (`30 8 * * *`) was dropped
// twice as "waited 10min > 10min", losing that day's round with no failure
// recorded — `skipped` neither retries nor counts as missed.
//
// Unparseable or absent schedules still return null: unknown keeps the old
// bound rather than widening the policy on bad data (design D2).
function cronFormPeriodMs(t) {
  const expr = t?.cron;
  if (!expr || typeof expr !== "string") return null;
  try {
    const iter = cronParser.parseExpression(expr, { tz: t.tz || undefined });
    const a = iter.next().toDate().getTime();
    const b = iter.next().toDate().getTime();
    const ms = b - a;
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  } catch {
    return null;
  }
}

function schedulePeriodMs(t) {
  const interval = t?.interval;
  if (interval && typeof interval === "object") {
    const step = INTERVAL_UNIT_MS[interval.unit];
    const n = Number(interval.number);
    if (Number.isFinite(step) && Number.isFinite(n) && n >= 1) return n * step;
    return null; // a malformed interval is bad data, not a licence to guess
  }
  return cronFormPeriodMs(t);
}

// Below this period a dropped round is cheap: the next occurrence is at most
// this far away. At or above it, dropping loses a meaningful slice of a day.
//
// Deliberately NOT compared against QUEUE_MAX_AGE_MS. That bound is a patience
// limit ("how long may a fire wait before it is stale"), not a cycle length;
// production runs it at 10 minutes, and every real cadence is longer than that
// — so "period > bound" would exempt the entire queue and silence the policy
// while looking like it still worked. (Found exactly this way: the first test
// run exempted the hourly case.)
//
// Read per call, like queueMaxAgeMs above — freezing it at module load is the
// snapshot trap this file has been bitten by before (a value read once at
// import time stays stale through every later env change and every test that
// repoints the store).
function staleExemptMinPeriodMs() {
  const raw = Number(process.env.QUEUE_STALE_EXEMPT_MIN_PERIOD_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 6 * 3_600_000;
}

// Is this queued round exempt from the age bound because losing it would cost
// more than the queueing pressure it relieves? Shared by the drop decision AND
// by the health snapshot: an exempt round must not count as evidence that the
// queue is stuck, or one waiting daily round would flip a healthy-but-idle cell
// to 503.
function isAgeExemptQueued(t, periodFloorMs = staleExemptMinPeriodMs()) {
  if (!t) return false;
  if (t.trigger !== "schedule" || t.queuedBy === "human") return false;
  const periodMs = schedulePeriodMs(t);
  return periodMs !== null && periodMs >= periodFloorMs;
}

function dropIfStaleQueued(t, nowMs) {
  if (!t || t.state !== "queued") return false;
  const maxAgeMs = queueMaxAgeMs();
  if (!(maxAgeMs > 0)) return false;
  // Only cadence fires age out: manual/event triggers never do, and neither does
  // a `run now` on a cadence task — the trigger reads "schedule" for both, so the
  // REQUESTOR decides (`queuedBy`), not the shape.
  if (t.trigger !== "schedule" || t.queuedBy === "human") return false;
  // A long-period round has no cheap successor: dropping it would lose a large
  // part of the day, so it waits instead of being discarded.
  if (isAgeExemptQueued(t)) return false;
  const anchor = queueAnchorMs(t);
  if (!Number.isFinite(anchor) || nowMs - anchor <= maxAgeMs) return false;
  const waitedMin = Math.round((nowMs - anchor) / 60_000);
  const boundMin = Math.round(maxAgeMs / 60_000);
  finishExecution(t, new Date(nowMs).toISOString(), {
    ok: false,
    skipped: true,
    error: `queue staleness: a scheduled fire waited ${waitedMin}min behind the cell's serial slot (>${boundMin}min) — dropped without running; the next cadence fire supersedes it`,
  });
  t.firstQueuedAt = null;
  t.queuedBy = null;
  console.log(`[task-engine] ${t.id}: dropped stale queued fire (waited ${waitedMin}min > ${boundMin}min)`);
  return true;
}

// The sweep: drop over-age cadence fires wherever they sit in the queue. Cheap —
// one pass over the task map on a slow timer, no I/O, no dispatch. Skipped turns
// spend no budget and leave no ledger instance, so running it often is free.
export function sweepStaleQueuedFires(nowMs = Date.now()) {
  if (!initialized) return 0;
  let dropped = 0;
  for (const t of tasks.values()) {
    if (dropIfStaleQueued(t, nowMs)) dropped += 1;
  }
  if (dropped > 0) void saveTasks();
  // Orphan re-dispatch (fix-orphaned-queued-executions): a task that loses its
  // pending execution while sitting still has nobody to re-fire it — the
  // enqueue-time heal only runs when someone enqueues. Live 2026-11-09: after
  // each finished turn the cell drifted back to `queued 1, running 0,
  // orphaned 1, degraded true` and stayed there. The same slow pass therefore
  // puts orphans back on the chain; it dispatches at most once per task per
  // sweep and never touches the in-flight execution.
  const onChain = new Set(pendingExecutions.map((e) => e.id));
  if (inFlightExecutionId) onChain.add(inFlightExecutionId);
  for (const t of tasks.values()) {
    if (t.state !== "queued" || onChain.has(t.id) || scheduleSideBlocked(t)) continue;
    // 池已经接了的（在它的 waiting 里）同样算"在链上"。
    // 不加这一条，sweep 每遍都会把同一个 id 再推一次 waiting：线上实测
    // cell 3fdc 每 30 秒打印一轮 5 条 "off the chain"，排队的轮 30 分钟
    // 没起步、`/readyz` 一直 503，而 `waiting` 还在无限增长
    // （2026-11-09，5 个 id × 每 30 秒）。判据必须与派发方共用一套认领语义。
    if (slotDispatcherFn?.claims?.(t.id)) continue;
    console.warn(`[task-engine] ${t.id} is queued but off the chain — re-dispatching (sweep)`);
    dispatch(t.id);
  }
  return dropped;
}

function queueWatchdogMs(task) {
  const raw = process.env.QUEUE_WATCHDOG_MS;
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    const n = Number(raw);
    // 0 (or a negative) disables the watchdog outright — an operator escape
    // hatch, and the only way to reproduce the pre-fix behaviour in tests.
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n;
  }
  let budget = null;
  try {
    budget = resolveBudgetFor(task);
  } catch { /* a broken resolver must not disable the watchdog */ }
  const base = Number.isFinite(budget) && budget > 0 ? budget : 10 * 60_000;
  return base + QUEUE_WATCHDOG_GRACE_MS;
}

// Main-chain fairness (fix-main-chain-human-priority). The primary slot is ONE
// serial chain, so a cadence backlog makes the owner's `execute now` wait behind
// every fire (live 2026-11-08: a run-now waited 180s behind 18 queued fires).
// `humanPriority` existed but only the worker pool honoured it — and prod runs
// `TASK_WORKER_MAX=0`, so the one turn a human asked for had no priority at all.
// Queueing instead of chaining eagerly lets the drain pick a human wake ahead of
// executions that have not started (never ahead of the running one: the chain is
// already busy by then).
function chainExecution(id) {
  const t = tasks.get(id);
  pendingExecutions.push({
    id,
    human: t?.humanPriority === true,
    fleetId: fleetKey(t),
    at: Date.now(),
  });
  drainExecutions();
}

// ── Fleet fairness (split-meta-team-queue-capacity) ─────────────────────────
//
// Live 2026-11-08: one cell hosts every fleet of one owner, and the primary slot
// is ONE serial chain. `drainExecutions` picked "first human, else oldest", so
// arrival order decided everything: a single fleet's 8-hop handoff chain filled
// 5-8 of 23 dispatch slots and the internal meta teams waited 78 and 48 minutes
// (both then timed out). The fix is a distribution policy, not new machinery —
// the selection point already exists here.
//
// Three tiers, in order:
//   1. a human wake (unchanged: the owner's own ignition still goes first);
//   2. fleet rotation — a fleet may not take more than FLEET_DISPATCH_BURST
//      consecutive slots while another fleet is waiting;
//   3. the meta lane — a fleet flagged internal gets one slot within
//      META_LANE_ROTATIONS rotations, with the reverse bound that normal fleets
//      never fall more than one slot behind the meta ones.
//
// Off by default (`FLEET_FAIR_QUEUE=1` enables): an unset env keeps the legacy
// "human first, else FIFO" selection byte for byte, so a GitOps rollout that has
// not synced yet cannot change production behaviour.
const FLEET_FAIR_DEFAULTS = { burst: 2, metaRotations: 2 };

function fairQueueEnabled() {
  return process.env.FLEET_FAIR_QUEUE === "1";
}

function readPositiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function fairQueueConfig() {
  return {
    burst: readPositiveIntEnv("FLEET_DISPATCH_BURST", FLEET_FAIR_DEFAULTS.burst),
    metaRotations: readPositiveIntEnv("META_LANE_ROTATIONS", FLEET_FAIR_DEFAULTS.metaRotations),
  };
}

// Who counts as an internal meta team is a POLICY question the engine must not
// answer itself (hard-coding team names here would rot as teams come and go).
// server.js injects the resolver — same seam style as setSlotDispatcher and
// setMandateGate. With no resolver every fleet is a normal fleet, so rotation
// still works and the meta lane simply never fires.
let metaFleetResolverFn = null;
function setMetaFleetResolver(fn) {
  metaFleetResolverFn = typeof fn === "function" ? fn : null;
}

function isMetaFleet(fleetId) {
  if (!fleetId || !metaFleetResolverFn) return false;
  try {
    return metaFleetResolverFn(fleetId) === true;
  } catch {
    return false; // a broken resolver degrades to "normal fleet", never throws
  }
}

// The fairness unit is the fleet a task belongs to. Tasks with neither tag (web
// lane manual work, cluster dispatches) share a single "unattributed" bucket so
// they still participate in rotation instead of being pushed to the back.
function fleetKey(t) {
  const id = t?.sourceTag?.fleetId ?? t?.origin?.fleet?.fleetId ?? null;
  return typeof id === "string" && id ? id : null;
}

// Rotation bookkeeping. Deliberately MONOTONIC (a dispatch counter plus "when did
// this fleet last run"), never reset when the waiting set changes shape: a reset
// keyed on the current set flips on every single-fleet tick and destroys the
// burst comparison. Monotonic counters also make "how long has this fleet
// waited" answerable without defining what a rotation is.
const fairRotation = {
  dispatchCount: 0, // total dispatches since boot
  lastFleet: undefined, // burst-counter owner
  burstCount: 0,
  lastServed: new Map(), // fleetKey|null → dispatchCount at its last dispatch
  metaServed: 0, // dispatches taken by internal fleets
  normalServed: 0, // dispatches taken by everyone else
};

function fairResetRotation() {
  fairRotation.dispatchCount = 0;
  fairRotation.lastFleet = undefined;
  fairRotation.burstCount = 0;
  fairRotation.lastServed.clear();
  fairRotation.metaServed = 0;
  fairRotation.normalServed = 0;
}

function fairNoteDispatch(key) {
  fairRotation.dispatchCount += 1;
  if (key === fairRotation.lastFleet) fairRotation.burstCount += 1;
  else {
    fairRotation.lastFleet = key;
    fairRotation.burstCount = 1;
  }
  fairRotation.lastServed.set(key, fairRotation.dispatchCount);
  if (isMetaFleet(key)) fairRotation.metaServed += 1;
  else fairRotation.normalServed += 1;
}

// Choose the index into `pendingExecutions` that runs next under the fair policy.
// Split out so the policy is unit-testable without a live queue.
//
// Order of consideration:
//   1. reverse bound — never let normal fleets trail the meta ones by ≥2 slots;
//   2. meta lane — an internal fleet that has gone META_LANE_ROTATIONS dispatches
//      without a slot jumps ahead;
//   3. burst — keep feeding the fleet that just ran until it hits
//      FLEET_DISPATCH_BURST, then hand the slot to the least-recently-served
//      fleet (this is what keeps an 8-hop chain flowing instead of shattering it
//      into 8 round-robin turns);
//   4. arrival order as the final tiebreak.
function pickFairIndex(pending, { burst, metaRotations } = fairQueueConfig()) {
  if (pending.length === 0) return -1;
  const keyOf = (e) => e.fleetId ?? null;
  const waitOf = (e) => fairRotation.dispatchCount - (fairRotation.lastServed.get(keyOf(e)) ?? 0);

  // 1. Reverse bound (spec: normal fleet slots ≥ meta slots − 1).
  if (fairRotation.metaServed > 0 && fairRotation.normalServed <= fairRotation.metaServed - 2) {
    let best = -1;
    let bestWait = -1;
    for (let i = 0; i < pending.length; i += 1) {
      if (isMetaFleet(keyOf(pending[i]))) continue;
      const w = waitOf(pending[i]);
      if (w > bestWait) {
        best = i;
        bestWait = w;
      }
    }
    if (best !== -1) return best;
  }

  // 2. Meta lane: an internal fleet overdue by metaRotations dispatches.
  if (metaRotations > 0) {
    let best = -1;
    let bestWait = -1;
    for (let i = 0; i < pending.length; i += 1) {
      if (!isMetaFleet(keyOf(pending[i]))) continue;
      const w = waitOf(pending[i]);
      if (w >= metaRotations && w > bestWait) {
        best = i;
        bestWait = w;
      }
    }
    if (best !== -1) return best;
  }

  // 3. Burst: keep the current fleet while it is under its burst limit.
  if (fairRotation.lastFleet !== undefined && fairRotation.burstCount < burst) {
    const same = pending.findIndex((e) => keyOf(e) === fairRotation.lastFleet);
    if (same !== -1) return same;
  }

  // 4. Least-recently-served fleet, arrival order among equals.
  let best = 0;
  let bestWait = -1;
  for (let i = 0; i < pending.length; i += 1) {
    const w = waitOf(pending[i]);
    if (w > bestWait) {
      best = i;
      bestWait = w;
    }
  }
  return best;
}

function drainExecutions() {
  if (executionDraining || pendingExecutions.length === 0) return;
  // First human wake in arrival order, else the oldest — FIFO among equals.
  let at = pendingExecutions.findIndex((e) => e.human);
  if (at === -1) {
    at = fairQueueEnabled() ? pickFairIndex(pendingExecutions) : 0;
  }
  const next = pendingExecutions.splice(at, 1)[0];
  if (fairQueueEnabled()) fairNoteDispatch(next.fleetId ?? null);
  executionDraining = true;
  // Between the splice above and the turn's own state flip there is a window in
  // which the task still reads `queued` while nothing holds it — that is the
  // in-flight execution, NOT an orphan (fix-orphaned-queued-executions).
  inFlightExecutionId = next.id;
  const done = () => {
    executionDraining = false;
    inFlightExecutionId = null;
    drainExecutions();
  };
  executionQueue = executionQueue.then(() => runQueuedExecutionWithWatchdog(next.id)).then(done, done);
}

// Read-only view for the readiness probe: who is waiting, per fleet.
function queueFairnessSnapshot({ now = Date.now() } = {}) {
  const byFleet = new Map();
  for (const e of pendingExecutions) {
    const key = e.fleetId ?? null;
    const cur = byFleet.get(key) ?? { fleetId: key, queued: 0, oldestWaitMs: null };
    cur.queued += 1;
    const waited = Math.max(0, now - (Number.isFinite(e.at) ? e.at : now));
    if (cur.oldestWaitMs === null || waited > cur.oldestWaitMs) cur.oldestWaitMs = waited;
    byFleet.set(key, cur);
  }
  const config = fairQueueConfig();
  return {
    enabled: fairQueueEnabled(),
    ...config,
    rotations: fairRotation.dispatchCount,
    served: Object.fromEntries(
      [...fairRotation.lastServed].map(([k, at]) => [k ?? "(unattributed)", fairRotation.dispatchCount - at]),
    ),
    fleets: [...byFleet.values()].map((f) => ({ ...f, meta: isMetaFleet(f.fleetId) })),
  };
}

async function runQueuedExecutionWithWatchdog(id) {
  const limit = queueWatchdogMs(tasks.get(id));
  if (!limit) return runQueuedExecution(id);

  const startedAt = new Date().toISOString();
  let timer = null;
  const watchdog = new Promise((resolve) => {
    timer = setTimeout(() => {
      const t = tasks.get(id);
      // The turn may have settled in the same tick the timer fired.
      if (t && t.state === "running") {
        finishExecution(t, startedAt, {
          ok: false,
          error: `queue watchdog: turn exceeded ${limit < 1000 ? `${limit}ms` : `${Math.round(limit / 1000)}s`} without settling — the serial queue was holding every other task behind it`,
        });
      }
      resolve("watchdog");
    }, limit);
    if (typeof timer?.unref === "function") timer.unref();
  });

  try {
    await Promise.race([runQueuedExecution(id), watchdog]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Hand an execution back to the primary slot's serial chain (the worker
// pool's spawn-failure fallback).
function runOnPrimary(id) {
  chainExecution(id);
}

// Chain an arbitrary turn-shaped job onto the same serialized queue (the
// delegation aggregator's summary injection rides this so it never overlaps a
// task execution or a runtime mutation).
function chainTurn(fn) {
  executionQueue = executionQueue.then(fn);
}

// The turn's time bound (fix-fleet-turn-budget): the injected resolver decides;
// the fallback constant covers hosts that inject nothing. Anything that is not a
// positive finite number falls back too — a resolver failure must degrade to the
// default, never to "0ms" (setTimeout(fn, undefined) fires immediately).
function resolveBudgetFor(task) {
  if (!resolveTurnBudgetFn) return TURN_TIMEOUT_MS;
  try {
    const ms = resolveTurnBudgetFn(task);
    return Number.isFinite(ms) && ms > 0 ? ms : TURN_TIMEOUT_MS;
  } catch {
    return TURN_TIMEOUT_MS;
  }
}

async function runQueuedExecution(id) {
  const t = tasks.get(id);
  // The schedule front-end may have paused/removed/completed the task between
  // enqueue and turn — reset the lifecycle and skip (pre-engine behavior: a
  // paused job's due firing silently did not run).
  if (!t || scheduleSideBlocked(t)) {
    if (t) {
      t.state = null;
      releaseCatchUpMarker(t);
      void saveTasks();
    }
    return;
  }
  // Queue staleness (fix-cell-turn-throughput 2.2): the serial slot is the
  // cell's only executor, so a burst of cadence fires (restart catch-up) can
  // build a backlog measured in HOURS — live 2026-11-08: 18 executions queued
  // behind one slot, the oldest 3.5h old, while a `run now` waited 180s and saw
  // nothing. A scheduled fire that has waited longer than the staleness bound
  // is not worth running at all: its patrol would read "now" data for a slot
  // that has already passed, and it holds every newer fire behind it. Drop it
  // as `skipped` (honest, no budget spent, no ledger instance) and let the next
  // cadence fire supersede it. Manual/event fires are never aged out — a human
  // asked for THAT round.
  // Manual/event fires are never aged out — a human asked for THAT round — and
  // neither is a `run now` on a cadence task (`queuedBy === "human"`). The
  // trigger reads "schedule" for both, so the REQUESTOR decides, not the shape.
  if (dropIfStaleQueued(t, Date.now())) return;
  await runExecutionTurn(t, runTurnFn);
}

// The shared execution body — primary slot and worker slots run the SAME
// lifecycle transitions; only the turn executor differs (the primary's
// switchPreset flow vs a worker's pinned-persona prompt).
async function runExecutionTurn(t, turnFn) {
  // Leaving the queue for a real run: the staleness anchor is spent.
  t.firstQueuedAt = null;
  t.queuedBy = null;
  // Session rotation (rotate-cron-session-on-context-pressure): a cron task's
  // session accumulates every round. Once the newest metered round sits at or
  // over the threshold, THIS round starts on a fresh session instead of
  // inheriting the near-window context. Rotation is per fire and sticky — the
  // new id is what the runner reads (`job.sessionId || cron-<id>`).
  const overflowAsked = t.rotateNextSession === true;
  // Rotate after a failed round too (ledger E35, live 2026-11-10). The
  // threshold below reads TOKEN USAGE — and a round that died on an upstream
  // 502/503 records no tokens at all, so `shouldRotateSession` never fires and
  // the task keeps re-using the SAME rotated id forever. Once the child that
  // owned that id is gone (bridge rebuild), every later round opens with
  // `502 upstream_error` at revision 3 / index 1 — measured: the job's
  // `sessionId` still carried `--r1794250091371` from 11:41 while rounds ran at
  // 12:19. A failed round leaves nothing worth resuming, so start clean.
  const lastOutcome = Array.isArray(t.history) ? t.history[t.history.length - 1] : null;
  const lastFailed = Boolean(lastOutcome) && lastOutcome.success !== true;
  if (t.trigger === "schedule" && (overflowAsked || lastFailed || shouldRotateSession(t.history))) {
    const previous = t.sessionId ?? null;
    t.sessionId = nextCronSessionId(t.id);
    t.sessionRotatedAt = Date.now();
    t.sessionRotatedFrom = previous;
    t.sessionRotatedThisTurn = true;
    t.rotateNextSession = false; // 用掉即清：留 true 会让之后每一轮都换会话
  } else {
    t.sessionRotatedThisTurn = false;
  }
  const startTime = new Date().toISOString();
  t.lastRun = startTime;
  t.state = "running";
  // Persist BEFORE the turn: a crash mid-execution reloads as `interrupted`
  // instead of silently reverting to idle (the pre-engine gap).
  void saveTasks();
  if (broadcastFn) broadcastFn({ type: "cron_fired", id: t.id, prompt: t.prompt, startTime, state: "running" });
  broadcastStatus(t.id);

  // The pre-turn seam (fix-fleet-context-injection-seam): the scheduling
  // front-end may compose this fire's prompt here — the only point every
  // enqueue path converges on, so no path can miss it. A seam failure is that
  // fire's failure, never a silent un-shaped prompt and never a broken engine:
  // it settles through the same finishExecution the turn itself uses.
  if (beforeTurnFn) {
    try {
      await beforeTurnFn(t);
    } catch (err) {
      finishExecution(t, startTime, { ok: false, error: err?.message || String(err) });
      return;
    }
  }

  // Fleet patrol context (agent-fleet-report-lane): the seam above may have
  // armed a transient, per-fire prompt. It rides the turn only — never
  // serialized, cleared on finish — so the stored prompt stays the reusable
  // template.
  const effective = t.promptOverride != null ? { ...t, prompt: t.promptOverride } : t;

  try {
    // The turn's time bound (fix-fleet-turn-budget): ask the scheduler. safeBudget
    // keeps the contract collectTurn relies on — a positive finite number, always
    // (setTimeout(fn, undefined) fires immediately and would kill every turn).
    const result = await turnFn(effective, { turnTimeoutMs: resolveBudgetFor(effective) });
    finishExecution(t, startTime, result);
  } catch (err) {
    finishExecution(t, startTime, { ok: false, error: err?.message || String(err), interrupted: err?.interrupted === true });
  }
}

// Arm the transient per-fire prompt override (agent-fleet-report-lane). The
// scheduling front-end calls this synchronously before enqueueing a fire whose
// {{fleetContext}} it rendered. Cleared in finishExecution; never persisted
// (saveTasks' whitelist drops it by design).
function setPromptOverride(id, prompt) {
  const t = tasks.get(id);
  if (!t) return false;
  t.promptOverride = prompt;
  return true;
}

// Worker entry point: a pool-owned execution claims the same guards and the
// same lifecycle, running its turn on the pool's executor.
async function beginExecution(id, turnFn) {
  const t = tasks.get(id);
  if (!t || scheduleSideBlocked(t)) {
    if (t) {
      t.state = null;
      releaseCatchUpMarker(t);
      void saveTasks();
    }
    return false;
  }
  await runExecutionTurn(t, turnFn);
  return true;
}

// Turn metering (add-turn-metering D3): the slot claimant records WHICH body
// runs this execution. Only claimants may call this — a worker slot marks
// worker+instance; the enqueue default (cell/remote) stands otherwise. The
// executor MUST NOT invent carrier values.
function markExecutionCarrier(id, carrier, instance = null) {
  const t = tasks.get(id);
  if (!t) return false;
  t.executionCarrier = { carrier, instance };
  return true;
}

function finishExecution(t, startTime, result) {
  // Any settlement is progress, whatever its outcome (a failed round still
  // freed the slot for the next one).
  lastSettledAt = Date.now();
  const interrupted = result?.interrupted === true;
  // fix-fleet-turn-attribution D4: a platform-skipped round (lane breaker
  // open) is its own state — NOT failed (it would poison the re-run surface
  // and the failure counts for work the platform chose not to start).
  const skipped = result?.skipped === true;
  const ok = result?.ok !== false && !interrupted && !skipped;
  t.state = skipped ? "skipped" : interrupted ? "interrupted" : ok ? "done" : "failed";
  t.error = ok ? null : result?.error || (interrupted ? "execution was interrupted" : "execution failed");
  // The per-fire fleet-context override is spent with this execution.
  t.promptOverride = null;
  // A catch-up run is spent too — the marker must not outlive the make-up (P2).
  const wasCatchUp = t.catchUpPending === true;
  t.catchUpPending = false;
  // The attempt serial of THIS execution (1 = a fresh cycle; higher = an
  // automatic retry). Recorded on the history entry so every attempt of a
  // retried task is individually visible.
  const attempt = Number.isInteger(t.attempt) && t.attempt >= 1 ? t.attempt : 1;

  // 溢出 → 下一轮必换会话（sticky，且要持久化：重启后仍然有效）。
  // 不在这里直接换 id，是因为换会话属于"开跑前"的决定（同 shouldRotateSession 的位置）。
  if (!ok && isContextOverflowError(t.error)) t.rotateNextSession = true;

  t.history.push({
    kind: HISTORY_KIND.EXECUTION,
    time: startTime,
    duration: Date.now() - new Date(startTime).getTime(),
    state: t.state,
    success: ok,
    attempt,
    ...(wasCatchUp ? { catchUp: true } : {}),
    ...(t.error ? { error: t.error } : {}),
    // 4.3：skipped 是个大桶（lane breaker、运行时未就绪、额度耗尽都落这里）。
    // 不标原因的话，读面只能看到"跳过了"，分不清"平台主动不跑"还是"额度用完了"
    // ——与 superseded 不报开关是同一个病。只在这一种 skip 上写。
    ...(result?.budgetExhausted ? { skippedReason: "budget_exhausted" } : {}),
    // The collected assistant text (remote a2a turns and cluster digests
    // return it). The report lane reads the last a2a turn's text to build the
    // derived execution summary (agent-fleet-report-lane D4).
    ...(result?.text ? { text: String(result.text).slice(0, 2000) } : {}),
    // Token spend when the runtime reports usage on the finish chunk
    // (absent on some providers — the card omits the line, never blocks).
    ...(result?.usage ? { tokens: result.usage } : {}),
    // Session rotation is a round-level fact: the history entry says whether
    // THIS round started on a fresh session, so a later reader can explain a
    // sudden cacheRead drop without guessing (rotate-cron-session-on-context-pressure).
    ...(t.sessionRotatedThisTurn ? { sessionRotated: true } : {}),
    // Per-member model attribution (agent-cluster-platform 3.15): a cluster
    // fan-out reports the model each member actually ran under. The lane is
    // the deployment's single provider — this records WHAT model id served
    // each member, not a fictional provider layer.
    ...(result?.models ? { models: result.models } : {}),
  });
  if (t.history.length > HISTORY_LIMIT) {
    t.history = t.history.slice(-HISTORY_LIMIT);
  }

  // Subscribers (scheduling front-end refreshes nextRun; the delegation
  // aggregator arms summary injections) — each guarded, none may lose the
  // outcome.
  for (const hook of onFinishedHooks) {
    try {
      hook(t);
    } catch { /* a subscriber failure must not lose the outcome */ }
  }

  void saveTasks();
  if (broadcastFn) {
    broadcastFn({
      type: "cron_completed",
      id: t.id,
      success: ok,
      state: t.state,
      ...(t.error ? { error: t.error } : {}),
      completedAt: new Date().toISOString(),
    });
  }
  broadcastStatus(t.id);

  // Failure retry policy: only a turn that RAN and failed follows it —
  // interrupted (a restart ate the turn) and skipped (the platform chose not
  // to start) keep their own semantics, and a success needs no policy.
  // Default max = 0 keeps this block inert on today's deployments.
  if (t.state === "failed") {
    const policy = resolveRetryPolicy(t.targetType);
    // Only a transient failure earns another attempt (ledger E26). A context
    // overflow would burn the same window again; a budget exhaustion is waste;
    // an upstream 502 or a not-ready runtime usually clears on its own.
    const transient = isTransientFailure(t.error);
    if (policy.max > attempt && transient) {
      scheduleRetry(t, attempt, policy);
    } else if (policy.max > attempt && !transient) {
      console.log(`[task-engine] ${t.id} failed permanently (${String(t.error).slice(0, 80)}) — not retried`);
    }
  }
}

// Register a fire that failed BEFORE execution could start. Now UNUSED by the
// fleet lane — the pre-turn seam (fix-fleet-context-injection-seam) settles a
// render failure through finishExecution instead, so the failure lands on the
// same lifecycle path as any other failed run. Kept as a general engine
// primitive: enqueue-side callers that need to reject a fire without running
// anything still have a shape for it.
function recordFailedFire(id, message) {
  const t = tasks.get(id);
  if (!t) return false;
  const now = new Date().toISOString();
  t.lastRun = now;
  t.state = "failed";
  t.error = message;
  t.promptOverride = null;
  t.history.push({ kind: HISTORY_KIND.EXECUTION, time: now, duration: 0, state: "failed", success: false, error: message });
  for (const hook of onFinishedHooks) {
    try {
      hook(t);
    } catch { /* a subscriber failure must not lose the outcome */ }
  }
  void saveTasks();
  broadcastStatus(id);
  return true;
}

// Run or re-run a task immediately (bypasses the schedule). Enqueues only —
// the WS ack (cron_run_started) must not wait out the whole turn; completion
// arrives as the cron_completed broadcast.
function runTaskNow(id) {
  // `by: "human"` rides the enqueue so the staleness policy can tell an
  // operator's ignition from a cadence fire on the same task record.
  return enqueueExecution(id, { by: "human" });
}

// Re-enqueue a round after a delay (2026-11-08): the readiness gate's retry
// ladder. Deliberately NOT a fresh run-now — the same task record re-enters
// the serialized queue, so the retry continues the round that was blocked
// (same prompt, same cadence slot) rather than minting a second round.
// Returns false when the task is gone or already queued/running: the caller
// must then treat the round as skipped, never as delivered.
function scheduleReenqueue(id, delayMs) {
  const t = tasks.get(id);
  if (!t) return false;
  if (t.state === "queued" || t.state === "running") return true;
  const ms = Number.isFinite(delayMs) && delayMs > 0 ? Math.floor(delayMs) : 0;
  const timer = setTimeout(() => {
    const live = tasks.get(id);
    if (!live) return;
    if (live.state === "queued" || live.state === "running") return;
    enqueueExecution(id);
  }, ms);
  timer.unref?.();
  return true;
}

// Await the serialized queue (tests, graceful drain). Executions are drained
// lazily (see chainExecution), so waiting on the promise tail alone would
// return while later executions still sit in the pending list.
async function idle() {
  while (executionDraining || pendingExecutions.length > 0) {
    const tail = executionQueue;
    await tail;
    // The drain chains the next execution from the tail's completion handler,
    // i.e. one microtask after `tail` resolves; give it that turn before
    // deciding the queue is empty.
    if (executionDraining || pendingExecutions.length > 0) await new Promise((r) => setImmediate(r));
  }
  await executionQueue;
}

// Register an on-finished subscriber (the delegation aggregator mounts after
// engine init, which clears subscribers).
function addOnFinished(fn) {
  onFinishedHooks.add(fn);
}

// ── Broadcasting ────────────────────────────────────────────────────────────

function broadcastStatus(id) {
  const task = getTask(id);
  if (task && broadcastFn) {
    broadcastFn({ type: "cron_status", job: task });
  }
}

// Passthrough for the scheduling front-end's own events (e.g. cron_removed).
function broadcastEvent(event) {
  broadcastFn?.(event);
}

function getRecentActivity() {
  const activities = [];
  for (const t of tasks.values()) {
    for (const h of t.history.slice(-5)) {
      activities.push({
        type: "cron_execution",
        jobId: t.id,
        prompt: t.prompt,
        time: h.time,
        success: h.success,
      });
    }
  }
  return activities.sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 50);
}

function getDashboardState() {
  return {
    jobs: listTasks(),
    activeTasks: [],
    recentActivity: getRecentActivity(),
    agentStatus: {
      isBusy: isBusyFn ? isBusyFn() : false,
    },
  };
}

// Fleet telemetry snapshot (unify-wanxing-management-plane): pure counts over
// the live store for the gateway's read-only relay to the fleet board. Counts
// and booleans only — prompts and other user content never take this path —
// and sampling has no side effects: it derives, it never mutates or queues.
function stats({ now = Date.now(), windowMs = 3_600_000 } = {}) {
  const executions = { running: 0, queued: 0 };
  const recent = { done: 0, failed: 0, interrupted: 0 };
  for (const t of tasks.values()) {
    if (t.state === "running") executions.running += 1;
    else if (t.state === "queued") executions.queued += 1;
    for (const h of Array.isArray(t.history) ? t.history : []) {
      const ts = Date.parse(h.time || h.completedAt || "");
      if (!Number.isFinite(ts) || ts < now - windowMs) continue;
      const state = h.state || (h.success === true ? "done" : h.success === false ? "failed" : null);
      if (state && Object.hasOwn(recent, state)) recent[state] += 1;
    }
  }
  let workers = { cap: 0, busy: 0, idle: 0 };
  if (workerStatsFn) {
    try {
      const w = workerStatsFn();
      if (w && typeof w === "object") {
        workers = {
          cap: Number(w.cap) || 0,
          busy: Number(w.busy) || 0,
          idle: Number(w.idle) || 0,
        };
      }
    } catch { /* a broken provider reads as an empty pool, never fails the snapshot */ }
  }
  return {
    jobs: tasks.size,
    executions,
    workers,
    recent,
    agentBusy: isBusyFn ? isBusyFn() : false,
  };
}

// ── Queue liveness (fix-task-queue-deadlock D3) ─────────────────────────────
//
// 2026-11-08 实盘：owner cell 的 776 个任务里 1 个 running（已 6.5 分钟未结算）
// + 22 个 queued（最早 00:34 就在排），而 /api/ready 仍报 {"ready":true}。
// 串行队列停摆时探针必须看得见，否则「假绿」会把一次停摆拖成数小时误诊。
//
// 纯函数：不带 IO、不缓存、不被队列状态反向影响——探针不能变成第二个
// 不透明点。`budgetOf(task)` 由调用方注入（引擎内部的预算解析器），缺席时
// 退化为只看排队的积压阈值。
export const QUEUE_MAX_OLDEST_QUEUED_MS = 10 * 60_000;
// Test seam: pretend a settlement happened at `at` (the projection only needs
// the fact, not the mechanism). Not exported on the public surface otherwise.
export function _stampSettlement(at = Date.now()) {
  lastSettledAt = at;
}

function queueHealth({ now = Date.now(), budgetOf = null, graceMs = null } = {}) {
  let queued = 0;
  let running = 0;
  let oldestQueuedMs = null;
  let oldestRunningMs = null;
  let overBudget = 0;
  // Rounds that will never be age-dropped (fix-stale-drop-respects-period).
  // Reported separately and deliberately NOT folded into `oldestQueuedMs`: the
  // operator runbook reads `oldestQueuedMs: null` as "no cell answered", so a
  // cell whose only queued round is exempt would otherwise look unreachable.
  // Naming the count keeps both facts readable instead of sacrificing one.
  let queuedExempt = 0;
  // 被顶替的轮次（3.3 的读面半边）。被顶替者已经落到 history 的
  // `kind:"superseded"` 行并留了 `supersededBy`，所以它自己也停在被顶替时的
  // `state="skipped"`——但只读 state 看不出"这是被同岗位新轮顶掉的"还是
  // "被老化/降级跳过的"。这里按 `supersededBy` 计数，让两种情况在 /api/ready
  // 上可分。
  //
  // 同时必须把**开关**一起报出去：产线 `QUEUE_SUPERSEDE_MANUAL` 未设时这条路径
  // 整段不生效，这个数就恒为 0。只报计数不报开关，读的人会把"功能没开"
  // 读成"从来没发生过顶替"——那正是本 change 一直在消灭的那类读数。
  let superseded = 0;

  for (const t of tasks.values()) {
    if (t.supersededBy) superseded += 1;
    if (t.state === "queued") {
      queued += 1;
      const anchor = queueAnchorMs(t);
      if (anchor !== null) {
        const waited = Math.max(0, now - anchor);
        // Age-exempt rounds are excluded from the age maximum on purpose: they
        // will never be dropped, so they must not act as evidence that the
        // queue is stuck. Counting them here means one waiting DAILY round —
        // with the cell otherwise idle — drives `queuedTooLong` true,
        // `stalled` true, `degraded` true, and `/api/ready` answers 503 for a
        // perfectly healthy cell. Losing a day's round is bad; broadcasting the
        // platform as not-ready is worse.
        if (isAgeExemptQueued(t)) {
          queuedExempt += 1;
        } else if (oldestQueuedMs === null || waited > oldestQueuedMs) {
          oldestQueuedMs = waited;
        }
      }
    } else if (t.state === "running") {
      running += 1;
      const startedAt = t.lastRun ? Date.parse(t.lastRun) : NaN;
      if (Number.isFinite(startedAt)) {
        const elapsed = Math.max(0, now - startedAt);
        if (oldestRunningMs === null || elapsed > oldestRunningMs) oldestRunningMs = elapsed;
        if (typeof budgetOf === "function") {
          let budget = null;
          try {
            budget = budgetOf(t);
          } catch { /* a broken resolver must not fail the snapshot */ }
          if (Number.isFinite(budget) && budget > 0) {
            const grace = Number.isFinite(graceMs) ? graceMs : budget;
            if (elapsed > budget + grace) overBudget += 1;
          }
        }
      }
    }
  }

  const queuedTooLong = oldestQueuedMs !== null && oldestQueuedMs > QUEUE_MAX_OLDEST_QUEUED_MS;
  // Stall vs busy (fix-queue-degraded-vs-busy): a long backlog with settlements
  // still flowing is a busy cell; a long backlog with NOTHING settling for the
  // same window is the stall the original probe was built to expose. Keep
  // `overBudget` unconditional — a turn past budget+grace is wrong in both
  // states.
  const settledRecently = lastSettledAt > 0 && now - lastSettledAt <= QUEUE_MAX_OLDEST_QUEUED_MS;
  const stalled = queuedTooLong && !settledRecently;
  // Orphans (fix-orphaned-queued-executions): tasks whose state says `queued`
  // but which hold no pending execution. They can never run, and nothing raises
  // an error for them, so the probe must say so — otherwise "queued 4,
  // running 0" reads like a busy cell while the single slot is dead. Live
  // 2026-11-09: exactly that for ~20 minutes, with `fairness` pending = 0.
  const onChain = new Set(pendingExecutions.map((e) => e.id));
  if (inFlightExecutionId) onChain.add(inFlightExecutionId);
  // 池已认领的也算在链上（fix-delegated-round-admission）：执行池把任务收进自己的
  // `waiting` 并让 dispatcher 返回 true，但这里的 onChain 只认串行链的两处来源，
  // 看不见池的等待队列；而周期清扫又按 `claims()` 跳过它们、不会自愈。后果不是
  // "少算一条"，是**长期假降级**：cell 在正常干活，`orphaned` 恒 > 0、`degraded`
  // 恒真、`/api/ready` 长期 503（2026-11-12 cell 1da519d4c1c0bf89 实测 11 条）。
  // 判据必须与派发方共用一套认领语义（同 sweepStaleQueuedFires 的那条注释）。
  // 派发器缺失或抛错时按"未认领"处理——探针可以保守报孤悬，不能反过来把真孤悬洗白。
  const claimedByPool = (id) => {
    const fn = slotDispatcherFn?.claims;
    if (typeof fn !== "function") return false;
    try {
      return fn(id) === true;
    } catch {
      return false;
    }
  };
  const suspects = new Set();
  for (const t of tasks.values()) {
    if (t.state === "queued" && !onChain.has(t.id) && !claimedByPool(t.id)) suspects.add(t.id);
  }
  const orphanIds = [...suspects].filter((id) => orphanCandidates.has(id));
  const orphaned = orphanIds.length;
  if (orphaned > 0) {
    console.warn(`[task-engine] queue health: ${orphaned} orphaned queued execution(s): ${orphanIds.slice(0, 5).join(", ")}`);
  }
  orphanCandidates = suspects;
  return {
    queued,
    running,
    oldestQueuedMs,
    oldestRunningMs,
    overBudget,
    // Age-exempt rounds waiting by design (see the counter's declaration): a
    // non-zero value here with `oldestQueuedMs === null` means "nothing
    // droppable is waiting", not "the cell is unreachable".
    queuedExempt,
    orphaned,
    // 3.3：顶替的可见性。`superseded > 0` 说明有轮次被同岗位新轮顶掉；
    // `supersedeEnabled === false` 说明这条路径根本没开，此数必然为 0，
    // 读数时不该据此判断"没有发生过顶替"。
    superseded,
    supersedeEnabled: supersedeManualEnabled(),
    lastSettledAt: lastSettledAt || null,
    degraded: stalled || overBudget > 0 || orphaned > 0,
  };
}

// ── Graceful shutdown ───────────────────────────────────────────────────────

// Timer cancellation is the scheduling front-end's (cron.js owns the
// node-schedule handles); the engine's queue is allowed to settle naturally.
// The engine's OWN timers — pending retry backoffs — die here: shutdown must
// not leave a timer that re-enqueues an execution behind the teardown.
function shutdown() {
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
  if (staleSweepTimer) {
    clearInterval(staleSweepTimer);
    staleSweepTimer = null;
  }
}

export {
  initTaskEngine,
  drainRepairQueue,
  isTransientFailure,
  loadTasks,
  saveTasks,
  whenTasksPersisted,
  getRecord,
  allRecords,
  insertTask,
  isInitialized,
  createManualTask,
  markExecutionCarrier,
  deleteRecord,
  clientShape,
  listTasks,
  getTask,
  getTaskRecord,
  enqueueExecution,
  runTaskNow,
  scheduleReenqueue,
  setPromptOverride,
  recordFailedFire,
  idle,
  chainTurn,
  addOnFinished,
  setSlotDispatcher,
  setMandateGate,
  // Fleet fairness (split-meta-team-queue-capacity): the selection policy and
  // its read-only projection. The resolver is injected (the engine must not own
  // the "which fleets are internal" question).
  setMetaFleetResolver,
  queueFairnessSnapshot,
  // Pure policy surface (split-meta-team-queue-capacity 1.3/2.2/2.3): the
  // selector and its rotation reset are exported so the dispatch ORDER can be
  // pinned by a test over a synthetic pending list, without a live queue.
  pickFairIndex,
  fairResetRotation,
  // Bookkeeping hook for the policy test: drainExecutions calls this after each
  // pick; exposing it lets a test advance the rotation while asserting order.
  fairNoteDispatch as __fairNoteDispatchForTest,
  fleetKey as __fleetKeyForTest,
  beginExecution,
  // history 条目的类型与汇总（1.4）：读方唯一入口，别再各写一份 cls()。
  HISTORY_KIND,
  classifyHistoryEntry,
  summarizeHistory,
  // Exported for the worker pool's watchdog: it settles a turn through the same
  // path the turn itself uses, so history/state semantics stay in one place.
  // (A local-only branch already exported this; the release base did not, which
  // is how the pool called `engine.finishExecution?.(...)` and silently did
  // nothing — the optional chain hid a missing dependency. Owned here so this
  // change does not inherit it from an unpushed commit.)
  finishExecution,
  runOnPrimary,
  broadcastStatus,
  broadcastEvent,
  getDashboardState,
  stats,
  queueHealth,
  // Period awareness (fix-stale-drop-respects-period): exported so the policy
  // can be pinned directly rather than inferred from queue behaviour — the
  // exempt predicate is the spec's "丢弃必须有接替者" rule in executable form.
  schedulePeriodMs,
  isAgeExemptQueued,
  staleExemptMinPeriodMs,
  // Budget resolver passthrough (fix-task-queue-deadlock D3): the readiness
  // probe asks the engine for each running task's own budget so "running past
  // budget+grace" is judged by the same number the turn was given — one
  // authority, no second copy of the policy in the probe.
  resolveBudgetFor,
  // Retry policy resolver (harden-cell-execution-reliability) — exported so
  // the env contract (default off, fail-closed, per-kind override) is pinned
  // by a test rather than only exercised on a failed execution.
  resolveRetryPolicy,
  shutdown,
  SUPPORTED_TARGET_TYPES,
};
