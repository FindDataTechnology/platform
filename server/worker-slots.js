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
import { collectTurn, resolveTurnBudgetMs, roundChildSessionId, fleetTagOf, parkPersonaForTurn, attributeFailureAndSalvage } from "./cron-runner.js";

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
// opts.spawnBridge/opts.idleReapMs/watchdogMs exist for tests (fake bridges, fast
// reap, deterministic watchdog). watchdogMs is explicit rather than env-driven so a
// suite cannot lose the setting to a sibling test's teardown.
export function attachWorkerPool(ctx, { spawnBridge = null, idleReapMs = IDLE_REAP_MS, watchdogMs = null } = {}) {
  const cap = readCap();
  if (cap <= 0) {
    ctx.workerPool = null;
    return { cap: 0, drain: async () => {}, shutdown: () => {} };
  }
  console.log(`[worker-pool] active, TASK_WORKER_MAX=${cap}`);

  const workers = new Set(); // { id, persona, bridge, busy, collectors, activeTurns, lastUsedAt, inFlight, humanPriority }
  const waiting = []; // task ids FIFO, pool-owned queue
  let workerSeq = 0;
  // The human-priority extra slot (add-turn-mandate-lane): ONE worker may
  // exist beyond cap, spawned only for a humanPriority task and reserved for
  // human wakes while it lives — normal tasks never claim it, and a second
  // human wake queues while it is busy (the extra slot is one).
  let humanExtraOut = false;
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
      const { method, params } = notif || {};
      // Route by the notification's OWN session id (2026-11-11). Keying only on
      // `worker.currentSession` silently dropped every notification that arrives
      // while no turn is "current" — the wrap-up salvage lane is exactly that:
      // it runs AFTER the main turn's finally cleared currentSession, so its
      // idle event never reached its collector and the salvage hung until its
      // 240s timeout (measured: the failure reached the ledger only after the
      // full wait). Throwing away the id the runtime already put on the
      // notification was the bug; currentSession stays as the fallback for
      // notifications that carry none.
      const sid = params?.sessionId ?? worker.currentSession;
      if (method === "bridge.exit" || method === "_bridge_crash") {
        const abort = worker.activeTurns.get(sid);
        if (abort) abort("the worker runtime restarted mid-turn");
        return;
      }
      const collector = worker.collectors.get(sid);
      collector?.(notif);
    };
  }

  async function spawnWorker(persona) {
    const construct = spawnBridge || ((params) => new DshBridge(params));
    // Per-member MCP patch (add-member-knowledge-profile): a worker is pinned
    // to ONE persona for its life, so the member's deployment identity can be
    // baked into a PRIVATE mcp patch (its own fd-memory row carrying the
    // member's deployment token, and the library row stamped with the
    // member's bound collections). The shared patch keeps serving the chat
    // lane byte-identically — this composition is additive and per-worker.
    // Fail-open: any compose failure falls back to the shared patch (the
    // persona runs with the owner-lane mount, exactly today's behavior).
    let memberPatchPath = null;
    try {
      memberPatchPath = (await ctx.composeMemberMcpPatch?.(persona)) ?? null;
    } catch (e) {
      console.warn(`[worker-pool] member patch compose failed for ${persona}; falling back to shared: ${e?.message || e}`);
    }
    const worker = {
      id: `worker-${++workerSeq}`,
      persona,
      busy: false,
      currentSession: null,
      collectors: new Map(),
      activeTurns: new Map(),
      lastUsedAt: Date.now(),
      inFlight: null,
      humanPriority: false,
    };
    worker.bridge = construct({
      ...ctx.workerSpawnParams,
      // The member's private mcp patch when one composed (per-member memory
      // token + library collections); null keeps the shared patch unchanged.
      ...(memberPatchPath ? { mcpPatchPath: memberPatchPath } : {}),
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
    // The MIRROR session: what the sidebar reads and the transcript lands on.
    const sessionId = task.sessionId;
    // The CHILD session the runtime is prompted under (fix-worker-session-rotation):
    // the serial chain rotates this per round since fix-fleet-round-discipline
    // (a stable id accumulated every round's history until compaction ate the
    // budget), but the pool path kept prompting the mirror id. Two consequences,
    // both measured on 2026-11-09: a worker turn re-read the same accumulated
    // conversation (the compaction storms this night chased), and with the pool
    // above one slot the same id was claimed from two places at once —
    // `session "…" is already owned by …`, 6 rounds, first seen 11:48Z the hour
    // the pool went from 1 to 3. Same derivation as the chain, so both lanes
    // identify a round the same way.
    const childSessionId = roundChildSessionId(task, Date.now(), task.roundSeq ?? 0);
    worker.currentFleet = fleetTagOf(task)?.fleetId ?? null;
    // `currentSession` is the COLLECTOR and ABORT key — pumpFor() and the slot
    // watchdog both read it — so it must be the id the runtime is actually
    // prompted under (the rotated child). The mirror id stays the transcript /
    // sidebar id below. Keeping these apart is the whole point of the rotation.
    worker.currentSession = childSessionId;
    worker.lastUsedAt = Date.now();
    // Turn accounting on the pool path (live 2026-11-08): a worker turn ran 43s
    // and reported `state=done success=true tokens{in769,out652}` while
    // `member_turn_events` gained no row, `trace.db` held 0 events for that
    // session and `/reports` was unchanged — the turn was unauditable, so the
    // fleet harness could not see it. The serial chain settles through
    // `ctx.recordFleetTurnEvent`; the pool must settle the same way.
    //
    // Settled exactly once via a latch: the bridge can reject AFTER the
    // collector already produced an outcome, and both branches must not each
    // write a row.
    const startedAt = Date.now();
    // Run ledger on the pool path (ledger E21's last gap, live 2026-11-10): the
    // serial chain opens one in runCronJobTurn, which registers the session for
    // collectTurn's trace tap and yields the turnId the row carries. The pool
    // never did — so EVERY worker round settled with `traceTurnId: null` and no
    // trace rows, and the acceptance harness could not see what it called (nor
    // how many tools it was handed). Same seam, one call, degrade-open.
    let ledgerTurn = null;
    try {
      ledgerTurn = ctx.fleetTurnLedger?.begin?.(task, { startedAt, sessionIds: [childSessionId] }) ?? null;
    } catch (e) {
      console.warn(`[worker-pool] ledger begin failed for ${task.id}: ${e?.message || e}`);
    }
    let settled = false;
    const settle = (out) => {
      if (settled) return out;
      settled = true;
      // Stamp the lane on EVERY settlement, including the failure paths.
      // Without this, a worker turn that failed (early stop / prompt error /
      // restart window) carried `carrier=null` in the ledger — indistinguishable
      // from "unknown", and it cost a lane-attribution detour on 2026-11-10 when
      // the three `stopped early` rows could not be attributed from the data.
      // An absent carrier is not an empty one: name the truth here.
      const withLane = {
        ...out,
        metering: { carrier: "worker", carrierInstance: worker.id, ...(out?.metering ?? {}) },
      };
      try {
        ctx.recordFleetTurnEvent?.(task, withLane, {
          startedAt,
          endedAt: Date.now(),
          // A tool task never calls a model; `null` keeps the ledger honest.
          model: task.targetType === "tool" ? null : (out?.usage?.model ?? null),
          // The handle opened above: the recorder writes turnId/runId/chain and
          // the trace key from it — that is what makes a worker round auditable.
          ledgerTurn,
        });
      } catch (e) {
        // Accounting must never swallow the turn's real outcome.
        console.warn(`[worker-pool] turn event record failed for ${task.id}: ${e?.message || e}`);
      }
      return out;
    };
    // A turn claimed while the runtime is restarting can never run (ledger E28,
    // live 2026-11-09: `spawned worker-1 for persona hotel-watch-scout` at
    // 23:36:16, `credential change: runtime child restarted` at 23:36:22 — the
    // turn died six seconds in and the row still said ok). The serial chain
    // waits for readiness before prompting (`awaitRuntimeReadyForJob`); the pool
    // did not, so a restart-shaped moment produced an empty success. Settle it
    // as interrupted here instead: the engine then offers a re-run and the
    // ledger stops claiming a round that never happened.
    if (ctx?.dshBridge?.isReady?.() === false || ctx?.dshBridge?.isRestarting?.() === true) {
      return settle({
        ok: false,
        interrupted: true,
        error: "the agent runtime was restarting when this slot was claimed — the round did not run",
      });
    }
    // Park the turn's persona onto THIS round's child session (ledger E31,
    // live 2026-11-10). The serial chain already does this before prompting;
    // the pool did not, so a worker round ran under the DEPLOYMENT default
    // preset — and `readMcpToolFilterFor(preset)` then found no `byPreset`
    // entry and fell back to the global union. Measured: a hotel-watch-scout
    // round carried 333-357 injected `tool-addition` entries instead of the 15
    // its pack declares, and that fixed overhead is what compacted the round
    // 4-6 times. Parking also writes the focused skills list (same helper).
    if (task.preset) {
      try {
        const park = await parkPersonaForTurn(ctx, task.preset, childSessionId);
        if (park?.legacy) {
          console.warn(`[worker-pool] ${task.id}: persona park fell back (${park.legacy}) — the round runs on the deployment preset`);
        }
      } catch (e) {
        console.warn(`[worker-pool] ${task.id}: persona park failed (turn continues): ${e?.message || e}`);
      }
    }
    chatHistory.recordMessage(sessionId, "user", task.prompt);
    if (task.sessionTitle) {
      try {
        chatHistory.setTitle(sessionId, task.sessionTitle);
      } catch { /* sanitize failure leaves the prompt-derived title */ }
    }
    // Early stop applies to a worker exactly as it does to the chain
    // (fix-worker-early-stop): both lanes run the same fleet rounds, and without
    // this the pool silently disabled the storm stop — measured 2026-11-09, three
    // consecutive rounds at 7/7/9 compactions each burned the full 600s because
    // they ran on workers, while the chain path stopped at 4.
    const collected = collectTurn(
      ctx, childSessionId, turnTimeoutMs, worker.activeTurns, worker.collectors, sessionId,
      {
        earlyStop: Boolean(fleetTagOf(task)),
        // The 60s floor stays the default; an embedder (or a test) may lower it.
        ...(Number.isFinite(ctx.earlyStopAfterMs) ? { earlyStopAfterMs: ctx.earlyStopAfterMs } : {}),
        // The session belongs to THIS worker's child process, not the primary
        // bridge: cancelling the primary would leave the round running (and the
        // slot blocked on `await bridge.prompt`) until it burned the full budget.
        cancelSession: (sid) => worker.bridge.cancelSession?.(sid),
      },
    );
    let result;
    try {
      await worker.bridge.prompt(childSessionId, [{ type: "text", text: task.prompt }]);
      result = await collected;
    } catch (e) {
      // prompt 抛错时 collectTurn 的 promise 还挂着：它内部挂着 turnTimeout 定时器
      // （默认 10 分钟），而这里原先只 delete 掉 abort/collector 两个表项，没有让它结算
      // ——于是十分钟后它以**未处理拒绝**的形式炸出来（实测 2026-11-08：一条
      // "prompt 抛错"的用例让整个测试文件以 "promise pending while event loop resolved" 失败）。
      // 正确做法是先主动结算（interrupted 语义），再清表；真正的错误照旧返回给引擎。
      const abortTurn = worker.activeTurns.get(childSessionId);
      worker.collectors.delete(childSessionId);
      worker.activeTurns.delete(childSessionId);
      try {
        abortTurn?.(`worker prompt failed: ${e?.message || String(e)}`);
        collected.catch(() => {}); // 结算后的拒绝由此吞掉；调用方拿的是下面的返回值
      } catch { /* 结算失败不能掩盖原始错误 */ }
      // The rejection carries the failure's own facts (`timeoutError` builds
      // detail with contextPressure / compactions / contextWindow). Dropping them
      // here is why most context-pressure failures were recorded anonymously:
      // measured 2026-11-11 over 24h, 77 of 105 such failures landed with
      // `detail = NULL`, and the worker lane carries most of the traffic. Absent
      // stays absent — forward whatever the error has, invent nothing.
      const failureDetail = e?.detail ?? null;
      return settle({
        ok: false,
        error: e?.message || String(e),
        interrupted: e?.interrupted === true,
        ...(failureDetail ? { detail: failureDetail } : {}),
      });
    } finally {
      worker.currentSession = null;
    }
    if (result.error) {
      // Parity with the serial chain (2026-11-11): a pressure/overflow failure on
      // the worker lane used to settle with NO detail and no salvage attempt —
      // the serial lane attributes the wall (contextPressure + compactions +
      // tokens) and asks the same session once for its report. The worker lane
      // carries most of the traffic, so skipping both meant its failures were
      // invisible in the ledger and its reports were lost.
      //
      // Both injections are the OWNERSHIP rule again: the session lives in this
      // worker's child, so the wrap-up prompt must go through its own bridge and
      // its own collector map (a prompt on the primary bridge reaches a child
      // that does not own the session).
      let detail = null;
      try {
        detail = await attributeFailureAndSalvage({
          ...ctx,
          dshBridge: ctx.dshBridge,
        }, {
          error: result.error,
          compactions: result.compactions ?? 0,
          reported: result.reported === true,
          text: result.text ?? "",
          childSessionId,
          mirrorSessionId: sessionId,
          isFleet: Boolean(fleetTagOf(task)),
          prompt: (sid, blocks) => worker.bridge.prompt(sid, blocks),
          collectors: worker.collectors,
          contextWindow: Number.isFinite(result.contextWindow) ? result.contextWindow : null,
          lastInputTokens: Number.isFinite(result.lastInputTokens) ? result.lastInputTokens : 0,
          usageSteps: Number.isFinite(result.usageSteps) ? result.usageSteps : 0,
          // Where the round started, so the worker lane can answer the same
          // question the serial chain can: baseline too big, or one tool reply?
          firstInputTokens: Number.isFinite(result.firstInputTokens) ? result.firstInputTokens : null,
          steps: Array.isArray(result.toolBlocks) ? result.toolBlocks.length : null,
        });
      } catch { /* attribution never changes the round's outcome */ }
      return settle({
        ok: false,
        error: result.error,
        ...(detail ? { detail } : {}),
        reported: result.reported === true,
      });
    }
    // Carry the WHOLE collected result, not just usage (ledger E28/E27): the
    // settlement seam judges "did this round actually produce anything" from
    // usage + text + tool calls, and E21's first cut dropped text/toolBlocks —
    // so a worker round that DID answer still looked empty and settled as a
    // hollow success. The same hollow flag the serial seam sets applies here.
    const produced = Boolean(result?.text) || Boolean(result?.toolBlocks?.length) || Boolean(result?.usage);
    return settle({
      ok: true,
      usage: result.usage ?? null,
      text: result.text ?? null,
      ...(Array.isArray(result.toolBlocks) ? { toolBlocks: result.toolBlocks } : {}),
      // The collector's facts must survive this rebuild (2026-11-11). This
      // object used to carry only usage/text/toolBlocks, so every worker round
      // silently lost three facts the settlement layer judges on:
      //   • reported — the stub guard and the delivery contract both read
      //     `reported === true`; dropping it made every worker round look like
      //     it filed nothing (false stub / false missingReport).
      //   • contextWindow / inputTokens — `windowFull` could never fire, which
      //     is why the overflow observability shipped on 2026-11-10 reported 0
      //     rows in 24h while 75 rounds in the same window were actually at
      //     ≥95% of the capacity (measured, not inferred).
      reported: result.reported === true,
      contextWindow: Number.isFinite(result.contextWindow) ? result.contextWindow : null,
      inputTokens: Number.isFinite(result.lastInputTokens) ? result.lastInputTokens : null,
      ...(produced ? {} : { hollow: true }),
    });
  }

  // Slot watchdog — the pool's counterpart to the serial chain's
  // `runQueuedExecutionWithWatchdog`. It is NOT optional decoration: with
  // TASK_WORKER_MAX > 0 the pool dispatcher claims queued tasks straight into
  // `beginExecution` and never enters the serial chain, so the chain's watchdog
  // cannot see them. A worker turn that never settles therefore holds its slot
  // forever and, at cap 2, silently halves throughput — exactly the failure the
  // serial watchdog was added for, relocated into the pool (live 2026-11-08:
  // the chain's guard exists, the pool had none).
  //
  // Releasing the slot is only half the job: the task must also be settled, or
  // it sits `running` in the ledger while its slot belongs to somebody else.
  // `engine.finishExecution` is the same path the turn itself uses, so history
  // and state semantics stay in one place.
  function poolWatchdogMs(task) {
    // 测试/嵌入方可直接给一个值，不必经过 env：同一测试文件里多用例共享 process.env，
    // 靠 env 传这个值会被别的用例的 teardown 抹掉（远端基上正是这么红的）。
    if (Number.isFinite(watchdogMs) && watchdogMs >= 0) return watchdogMs;
    const raw = process.env.QUEUE_WATCHDOG_MS;
    if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : 0; // 0 disables, same escape hatch
    }
    let budget = null;
    try {
      budget = resolveTurnBudgetMs(task);
    } catch { /* a broken resolver must not disable the watchdog */ }
    const base = Number.isFinite(budget) && budget > 0 ? budget : 10 * 60_000;
    return base + 5 * 60_000; // same grace as the serial chain
  }

  // Run one queued task id on a worker slot, then service the wait queue.
  async function runTaskOn(worker, id) {
    // 交还认领标记：从这里开始该执行的归属是引擎的 in-flight 语义，
    // 池不再声称它在 waiting 里（否则任务结束后标记会永久残留）。
    claimed.delete(id);
    // Turn metering (add-turn-metering D3): the slot claimant is the only
    // authority on "this ran on a worker" — mark before the execution reads it.
    engine.markExecutionCarrier?.(id, "worker", worker.id);
    worker.busy = true;
    emitPoolState();
    const limit = poolWatchdogMs(engine.getRecord?.(id) ?? null);
    let timer = null;
    const startedAt = new Date().toISOString();
    const watchdog = limit > 0
      ? new Promise((resolve) => {
        timer = setTimeout(() => {
          console.warn(`[worker-pool] ${id} exceeded ${Math.round(limit / 1000)}s without settling — aborting so the slot can be reused`);
          // 两步都必须做，少一步就是假的：
          //   ① abort 该回合 → collectTurn 结算 → runOnWorker 返回 → finally 释放槽位。
          //      只结算台账的话 `await exec` 永不返回，finally 不执行，**槽位永远不释放**
          //      （第一版实现就漏了这步，测试只验状态没验槽位复用，所以没抓到）。
          //   ② 若台账仍停在 running，用与回合自身相同的 finishExecution 收尾，
          //      让 history/state 语义只有一处。
          try {
            const sid = worker.currentSession;
            const abortTurn = sid ? worker.activeTurns?.get?.(sid) : null;
            abortTurn?.("worker watchdog: turn exceeded its budget without settling");
          } catch (e) {
            console.warn(`[worker-pool] watchdog abort failed for ${id}: ${e?.message || e}`);
          }
          const rec = engine.getRecord?.(id);
          if (rec && rec.state === "running") {
            try {
              engine.finishExecution?.(rec, startedAt, {
                ok: false,
                error: `worker watchdog: turn exceeded ${Math.round(limit / 1000)}s without settling — the pool slot was held for that whole time`,
              });
            } catch (e) {
              console.warn(`[worker-pool] watchdog settle failed for ${id}: ${e?.message || e}`);
            }
          }
          resolve("watchdog");
        }, limit)
        timer.unref?.();
      })
      : null;
    try {
      const exec = engine.beginExecution(id, (task, opts) => runOnWorker(worker, task, opts));
      await (watchdog ? Promise.race([exec, watchdog]) : exec);
    } finally {
      if (timer) clearTimeout(timer);
      worker.busy = false;
      worker.currentFleet = null;
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
  // Fleet admission gate (add-fleet-carrier): per-fleet in-flight ceiling —
  // the fleet dimension of "agents decide, platform caps". Queued, never
  // failed or preempted; a slot release lets the FIFO proceed. Remote turns
  // are NOT counted (runner-side budget governs those).
  // The spawn→runTaskOn gap is async — a fleet's second task could slip past
  // the gate while the first worker is still materializing. pendingFleets
  // bridges it: incremented SYNCHRONOUSLY at claim time, decremented once the
  // worker records its currentFleet.
  const pendingFleets = new Map();
  function fleetInFlight(fleetId) {
    if (!fleetId) return 0;
    return [...workers].filter((w) => w.busy && w.currentFleet === fleetId).length + (pendingFleets.get(fleetId) ?? 0);
  }
  // 人工点火优先（harden-fleet-execution-economics 3.x）。**默认关闭**。
  //
  // 缺口（2026-11-09 实测）：`queuedBy === "human"` 被三处豁免同时保护——
  //   ① 老化不丢它（queueMaxAgeMs 只丢非 human 的 schedule 触发）；
  //   ② 顶替不动它（supersedeQueuedForPost 显式跳过 human）；
  //   ③ 但池里 human 只换来"多一个额外槽"，**没有优先认领**。
  // 于是它成了"既不能被丢弃、也不能被顶替、又抢不到槽"的任务——实测
  // hotel-watch-scout 以 queuedBy=human 在队列里等了 20 分钟，而 nextRun
  // 已经是第二天：它被礼貌地饿死，而系统认为自己"正确地没丢它"。
  //
  // 打开后：`waiting` 里 human 的任务优先参与派发（仍然是"能派就派"，不改
  // 岗位亲和与舰队闸的判定）。默认关闭是为了不擅自改变生产调度顺序。
  function humanFirstEnabled() {
    const raw = process.env.QUEUE_HUMAN_PRIORITY;
    return String(raw ?? "").trim() === "1" || String(raw ?? "").toLowerCase() === "true";
  }

  // 派发决策留痕（默认关闭，避免生产日志噪音）。为什么要它：dispatcher 的
  // claim/fallback 决定**完全不留痕**，于是"任务为什么没进池"只能靠猜——
  // 2026-11-09 我为此连续误判两次（先怪 cap、再怪 spawning 泄漏）。
  function dispatchDebugEnabled() {
    const raw = process.env.WORKER_POOL_DEBUG;
    return String(raw ?? "").trim() === "1" || String(raw ?? "").toLowerCase() === "true";
  }

  // ── Retiring an idle worker whose persona nobody is waiting for ────────────
  //
  // Capacity used to be counted by WORKER COUNT (`workers.size + spawning <
  // cap`), but a worker is bound to ONE persona for its life. Those two facts
  // together lock the pool: a worker whose round finished stays idle AND stays
  // counted, so the next due task from a DIFFERENT persona can neither reuse it
  // (persona mismatch) nor spawn (size == cap) — it waits for the 5-minute idle
  // reap to give the slot back.
  //
  // Measured on the owner cell 2026-11-13T02:41Z with cap 4:
  //
  //   {"executions":{"running":3,"queued":6},"workers":{"cap":4,"busy":2,"idle":2}}
  //
  // Two slots spinning, six rounds queued, nothing dispatched. Effective
  // concurrency for a mixed-persona queue was ~cap/2, and every persona switch
  // cost up to 5 minutes of dead time — which is why the 08:20 daily round was
  // still queued at 10:41 and why the `*/20` monitors kept getting age-dropped.
  //
  // So "at cap" now means "cap workers that are busy OR bound to a persona some
  // queued task still targets". An idle, unneeded worker is a slot in name only
  // and is retired on demand — same shutdown path as the reap, same slot.
  function retireCandidate(targetPersona) {
    const wanted = new Set();
    for (const id of waiting) {
      const t = engine.getRecord?.(id);
      if (t?.preset) wanted.add(t.preset);
    }
    // Two exclusions, both load-bearing:
    //   • a worker whose persona some queued task still targets is that task's
    //     warm start — retiring it turns one wait into two cold starts;
    //   • a human-priority worker IS the reserved extra slot (add-turn-mandate-
    //     lane): normal tasks never take it, so neither may they retire it.
    //     Caught by the existing "human wake uses the extra slot" case, which
    //     went green→red the first time this filter was missing.
    const spare = [...workers].filter(
      (w) => !w.busy && !w.humanPriority && w.persona !== targetPersona && !wanted.has(w.persona),
    );
    if (!spare.length) return null;
    // Longest-unused first: the hottest warm worker is the one most likely to
    // serve the next round of its own persona.
    return spare.reduce((a, b) => (a.lastUsedAt <= b.lastUsedAt ? a : b));
  }

  function hasRetirableIdle(targetPersona) {
    return retireCandidate(targetPersona) !== null;
  }

  function retireIdleWorker(targetPersona) {
    const w = retireCandidate(targetPersona);
    if (!w) return false;
    // Delete SYNCHRONOUSLY: the slot has to be back in `workers.size` before
    // the caller recomputes `beyondCap`, or the spawn is refused for the very
    // capacity this just freed. stopBridge is the reap's own shutdown ladder.
    workers.delete(w);
    if (w.humanPriority) humanExtraOut = false;
    const idleSec = Math.round((Date.now() - w.lastUsedAt) / 1000);
    stopBridge(w.bridge);
    emitPoolState();
    console.log(`[worker-pool] retired idle ${w.id} (persona ${w.persona}, unused ${idleSec}s) so ${targetPersona} can take the slot`);
    return true;
  }

  function scheduleNext() {
    const fleetCap = (() => {
      const n = Number(process.env.FLEET_MAX_INFLIGHT);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4;
    })();
    while (waiting.length) {
      const placeable = (id) => {
        const t = engine.getRecord(id);
        if (!t || t.paused || t.status === "expired" || t.status === "completed") return false;
        const persona = t.preset;
        if (!persona) return false;
        const fleetId = t.sourceTag?.fleetId ?? null;
        if (fleetId && fleetInFlight(fleetId) >= fleetCap) return false; // admission gate: stay queued
        const human = t.humanPriority === true;
        // Idle match: a human wake may take the idle human-priority worker
        // (the extra slot); normal tasks never do — it stays reserved.
        if ([...workers].some((w) => !w.busy && w.persona === persona && (!w.humanPriority || human))) return true;
        // Spawn room: within cap as before; the ONE extra slot beyond cap
        // exists only for a human wake while none is outstanding. Beyond cap,
        // a slot is still obtainable by retiring an idle worker whose persona
        // no queued task targets (see retireCandidate) — that worker would
        // otherwise hold the slot until its 5-minute reap.
        if (workers.size + spawning < cap) return true;
        if (human && !humanExtraOut) return true;
        return hasRetirableIdle(persona);
      };
      // 人工点火优先：先在可派的任务里挑 human 的，挑不到再按原顺序。
      let idx = -1;
      if (humanFirstEnabled()) {
        idx = waiting.findIndex((id) => {
          const t = engine.getRecord(id);
          if (!(t && (t.humanPriority === true || t.queuedBy === "human"))) return false;
          return placeable(id);
        });
      }
      if (idx === -1) idx = waiting.findIndex(placeable);
      if (idx === -1) return;
      const id = waiting.splice(idx, 1)[0];
      const task = engine.getRecord(id);
      if (!task) continue;
      const persona = task.preset;
      const human = task.humanPriority === true;
      const idle = [...workers].find((w) => !w.busy && w.persona === persona && (!w.humanPriority || human));
      if (idle) {
        const idleFleetId = task.sourceTag?.fleetId ?? null;
        if (idleFleetId) pendingFleets.set(idleFleetId, (pendingFleets.get(idleFleetId) ?? 0) + 1);
        const p = runTaskOn(idle, id);
        if (idleFleetId) {
          const left = (pendingFleets.get(idleFleetId) ?? 1) - 1;
          if (left <= 0) pendingFleets.delete(idleFleetId);
          else pendingFleets.set(idleFleetId, left);
        }
        void p;
        continue;
      }
      // The extra slot: computed BEFORE the spawning increment — at/beyond
      // cap, only a human wake with no extra outstanding may spawn. The
      // claim books SYNCHRONOUSLY here (the spawn→run gap is async — the
      // same class of race pendingFleets bridges); the .then only pins the
      // worker's flag once it exists.
      let beyondCap = workers.size + spawning >= cap;
      if (beyondCap) {
        if (human && !humanExtraOut) {
          humanExtraOut = true; // the extra slot, as before — never at a worker's expense
        } else {
          // No human entitlement: reclaim a slot from an idle worker nobody
          // is waiting for, then recompute. `placeable` already proved one
          // exists, so failing here means the pool changed underneath us
          // (a reap or a claim landed) — leave the task queued and let the
          // next scheduleNext see the fresh state.
          if (!retireIdleWorker(persona)) return;
          beyondCap = workers.size + spawning >= cap;
        }
      }
      spawning++;
      const spawnFleetId = task.sourceTag?.fleetId ?? null;
      if (spawnFleetId) pendingFleets.set(spawnFleetId, (pendingFleets.get(spawnFleetId) ?? 0) + 1);
      spawnWorker(persona)
        .then((w) => {
          spawning--;
          if (beyondCap) w.humanPriority = true;
          const p = runTaskOn(w, id);
          if (spawnFleetId) {
            const left = (pendingFleets.get(spawnFleetId) ?? 1) - 1;
            if (left <= 0) pendingFleets.delete(spawnFleetId);
            else pendingFleets.set(spawnFleetId, left);
          }
          return p;
        })
        .catch((err) => {
          spawning--;
          if (beyondCap) humanExtraOut = false; // the extra spawn never landed
          console.error(`[worker-pool] spawn for ${persona} failed: ${err.message}; task ${id} falls back to the primary slot`);
          engine.runOnPrimary(id);
        });
    }
  }

  // The engine's slot dispatcher: claim persona-targeted executions whenever
  // the pool can serve them now or soon; anything else goes to the primary.
  // 已认领但还没真正开始跑的 task id。
  //
  // 为什么需要它：`dispatcher` 的语义是"这个我接了"——它把 id 推进 `waiting`
  // 然后**返回 true**，引擎据此认为"已在链上"。但引擎的 onChain 集合只认
  // `pendingExecutions` + `inFlightExecutionId`，看不到池里的 `waiting`。
  // 于是负责补漏的 sweep 每一遍都判定这些任务是"queued but off the chain"，
  // 打印告警并把同一个 id **再推一遍** waiting —— 线上实测每 30 秒循环一次、
  // 永不停止，队列因此既排不空也不会报错（2026-11-09 cell 3fdc 实测）。
  // 这份集合就是给引擎问"这个 id 到底在不在链上"用的。
  const claimed = new Set();

  function dispatcher(task) {
    if (!task) return false;
    const dbg = dispatchDebugEnabled();
    const no = (why) => {
      if (dbg) console.log(`[worker-pool] dispatch ${task.id} -> fallback:${why}`);
      return false;
    };
    if (task.trigger !== "manual" && task.trigger !== "schedule") return no(`trigger=${task.trigger}`);
    // Carrier gate (add-fleet-carrier): the CONFIGURED placement decides
    // claim eligibility — cell tasks stay on the primary chain, runner tasks
    // route through the remote executor; only worker/auto tasks are claimed.
    // auto = today's behavior (claim when the pool is active).
    const carrier = task.carrier ?? "auto";
    if (carrier === "cell" || carrier === "runner") return no(`carrier=${carrier}`);
    // a2a targets are remote turns (add-agent-delegation-a2a) — no persona to
    // pin; they ride the primary chain's remote executor.
    if (task.targetType === "a2a") return no("targetType=a2a");
    // Cluster targets (agent-cluster-platform): `preset` carries the cluster
    // id, not a persona — a worker pinned to it would boot a broken child.
    // The primary chain's cluster executor fans members out itself.
    if (task.targetType === "cluster") return no("targetType=cluster");
    // Tool targets (add-tool-posts): `preset` carries the "server::tool" ref,
    // not a persona — the engine writes `preset = persona ?? agent ?? tool`, so
    // "does it have a preset?" is TRUE for every tool post and can never be the
    // gate. A worker pinned to it boots a child that answers
    // `Unknown agent preset: <tool>` on every fire (measured 8× on a 盯梢岗
    // cadence, latest 2026-11-13T03:05:44Z), while the primary chain's
    // `toolExecutor` — one deterministic MCP call, no runtime, no LLM — never
    // got the task. One line per targetType, judged on targetType itself.
    if (task.targetType === "tool") return no("targetType=tool");
    // Null-ref (legacy live-preset) tasks have no persona to pin a worker to.
    if (!task.preset) return no("no-preset");
    if (!claimed.has(task.id)) {
      claimed.add(task.id);
      waiting.push(task.id);
    }
    if (dbg) console.log(`[worker-pool] dispatch ${task.id} -> claim:${task.preset}`);
    scheduleNext();
    return true;
  }

  reapTimer = setInterval(() => {
    let changed = false;
    for (const w of [...workers]) {
      if (w.busy) continue;
      if (Date.now() - w.lastUsedAt > idleReapMs) {
        workers.delete(w);
        if (w.humanPriority) humanExtraOut = false; // the extra slot frees with its worker
        changed = true;
        stopBridge(w.bridge);
        console.log(`[worker-pool] reaped ${w.id} (persona ${w.persona}, idle)`);
      }
    }
    if (changed) {
      emitPoolState();
      // Freed capacity re-opens the waiting queue — a reap must dispatch, or
      // queued tasks starve until the next turn's finally.
      scheduleNext();
    }
  }, Math.min(REAP_SCAN_MS, Math.max(200, idleReapMs)));
  reapTimer.unref?.();

  // 让引擎的 orphan sweep 能问"这个 id 是不是池已经接了"。
  dispatcher.claims = (id) => claimed.has(id);
  engine.setSlotDispatcher(dispatcher);

  return {
    cap,
    // Read-only occupancy for the fleet stats snapshot — counts only, never
    // personas (the WS broadcast carries those for the UI; telemetry does not).
    poolStats: () => {
      const busy = [...workers].filter((w) => w.busy).length;
      return { cap, busy, idle: workers.size - busy };
    },
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
