// ── Scheduling front-end ─────────────────────────────────────────────────────
//
// The schedule trigger kind of the task engine (add-task-engine; ADR 0006):
// this module owns WHEN tasks fire — cron/one-shot schedules in an optional
// IANA timezone, missed-occurrence accounting, pause/resume, and expiry. Task
// records, the execution lifecycle, the serialized queue, and the task event
// surface live in task-engine.js; a firing hands the task to the engine's
// enqueueExecution. The public API shape (server.js, server/ws.js,
// server/routes/cron.js) is unchanged from the pre-engine cron module.

import schedule from "node-schedule";
import cronParser from "cron-parser";
import * as engine from "./task-engine.js";
import {
  catchUpWindowMs,
  withinCatchUpWindow,
  countMissedBetween,
  MAX_MISSED_PER_LOAD,
} from "./server/cron-decisions.js";
import { resolveTurnBudgetMs, fleetTagOf } from "./server/cron-runner.js";

// ── Initialization ────────────────────────────────────────────────────────────

async function initCron({ broadcast, runJobTurn, isBusy, workerStats, renderFleetContext }) {
  setFleetContextRenderer(renderFleetContext ?? null);
  await engine.initTaskEngine({
    broadcast,
    runTurn: runJobTurn,
    isBusy,
    onFinished: (task) => {
      // Interval + finite-run lifecycle first (it may retire the task), then
      // the generic next-run refresh for every kind.
      onIntervalFinished(task);
      refreshNextRun(task);
    },
    // Occupancy provider for the fleet stats snapshot — a closure so the
    // worker pool (attached after init) is picked up lazily (unify-wanxing-management-plane).
    workerStats,
    // The pre-turn seam (fix-fleet-context-injection-seam): fleet context and
    // the catch-up prefix are composed HERE, once, for every enqueue path.
    beforeTurn: composeFleetPrompt,
    // How long this turn may run (fix-fleet-turn-budget): one resolver, shared
    // with the runner's own fallback, so the engine never invents a bound. Both
    // declarable budgets (cadence.turnTimeoutMs, constraints.budgetPerEdgeMin)
    // land here — the engine used to hand every turn a fixed 10 minutes, which
    // made all five resolver tests true and the behavior false.
    resolveTurnBudget: (task) => resolveTurnBudgetMs(task),
  });

  // Scheduling pass over the engine's loaded records: downtime accounting
  // before rescheduling, then arm timers / mark expiry. Afterwards the engine
  // re-enqueues executions that were persisted as queued at load.
  // Interval rows arm through the same scheduleJob (the next occurrence is
  // recomputed from the stored anchor grid); they have no cron-style catch-up
  // accounting — an occurrence that passed while down fires at the next grid
  // point. Skipping them here silently killed every interval task at restart
  // (fix-audit-code-gaps: spec — recurring schedules reschedule automatically).
  const catchUp = []; // tasks whose downtime gap still deserves one make-up run
  for (const j of engine.allRecords()) {
    if (j.type === "recurring" && (j.cron || j.interval)) {
      // Downtime accounting happens before rescheduling: occurrences entirely
      // covered by the downtime window are recorded as missed. A DELIVERY task
      // inside its tolerance window then gets ONE catch-up run (P2, 2026-10-26:
      // an unattended fleet silently lost a patrol when a restart covered its
      // trigger — a counter in a log nobody reads is not a delivery guarantee).
      // Outside the window the gap is past saving: record AND alert explicitly
      // (harden-cell-execution-reliability) — the miss record alone is not
      // sufficient, silent swallowing is banned. Cron-only: interval rows have
      // no cron expression to parse.
      // 到期未执行（missed）只统计**本该跑却没跑**的轮次。暂停任务不在其列：
      // 不跑是所有者的本意（同 test-cron-catchup "boot 暂停任务窗外丢轮" 的口径），
      // 但这里原先只把 `!j.paused` 用在补跑与告警上，计数与落盘没拦——
      // 于是一个 10-25 就暂停的 `17 * * * *` 每小时任务在每次 cell 重启时都记一笔
      // 缺口，24h 内被记了 2700 次（27 行 × 上限 100），读起来像"排队饥饿"。
      // 暂停即无义务，一律不计数、不写历史行。
      if (j.cron && !j.paused) {
        const missed = countMissedOccurrences(j);
        if (missed > 0) {
          void engine.saveTasks();
          // 记下「这一轮替几个周期代跑」：跨多个周期时这里只 push **一次**（不是每周期
          // 各一次），`missed` 就是被跳过的那几个周期的数量，随入队一起带给引擎落到
          // 该轮的 history 详情里（coalesce-catchup-with-fresh-fire 1.3）。
          if (withinToleranceWindow(j)) catchUp.push({ id: j.id, missed });
          else alertMissedBeats(j, missed);
        }
      }
      scheduleJob(j);
    } else if (j.type === "once" && !j.paused) {
      const scheduledAt = new Date(j.when);
      if (scheduledAt > new Date()) {
        scheduleJob(j);
      } else {
        // One-shot tasks that passed their scheduled time while down are
        // marked expired; they stay in history only.
        j.status = "expired";
        void engine.saveTasks();
      }
    }
  }
  // Catch-up runs are enqueued on the same serial chain as scheduled fires, so
  // they queue behind (never interleave with) whatever boot is already doing.
  // The marker rides the task record for the duration of that run: prompt
  // prefix + cockpit/report evidence show this was a make-up, never a normal
  // patrol (a caught-up round must not read as "the 09:00 patrol happened").
  //
  // The prefix itself is NOT written here anymore (fix-fleet-context-injection-
  // seam): pre-writing promptOverride lost the prefix whenever the injection
  // replaced the prompt wholesale, and lost the context whenever the repair
  // queue raced ahead. `catchUpPending` is the marker the seam reads.
  for (const { id, missed } of catchUp) {
    const t = engine.getRecord(id);
    if (!t) continue;
    console.log(`[cron] Task ${id} catch-up run enqueued (downtime gap, still inside the tolerance window)`);
    // 意图随入队一起传下去，**不再**先置 `t.catchUpPending`：marker 先置上的话，引擎
    // 就分不出「队列里原本那一轮」是补跑还是新鲜（它读到的 marker 已经是本次刚设的），
    // 合并方向那条判据随之失效。引擎在真正建出这一轮时按 `opts.catchUp` 置 marker。
    void fireTask(id, { catchUp: true, missed });
  }
  engine.drainRepairQueue();
}

// ── Cluster task policy validation (agent-cluster-platform) ─────────────────
//
// Shape gate for executionPolicy/targetAgents on cluster tasks. The cluster's
// existence is the route layer's check (it owns clusters.db); this side owns
// the scheduling-neutral field shapes so every entry path (REST, WS, MCP)
// validates identically.
const RESULT_AGGREGATIONS = ["first", "all", "summary"];

function validateClusterPolicy({ executionPolicy, targetAgents }) {
  if (executionPolicy !== undefined) {
    if (typeof executionPolicy !== "object" || executionPolicy === null || Array.isArray(executionPolicy)) {
      return "executionPolicy must be an object";
    }
    const { allowParallel, timeoutMinutes, resultAggregation } = executionPolicy;
    if (allowParallel !== undefined && typeof allowParallel !== "boolean") {
      return "executionPolicy.allowParallel must be a boolean";
    }
    if (
      timeoutMinutes !== undefined &&
      (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0 || timeoutMinutes > 1440)
    ) {
      return "executionPolicy.timeoutMinutes must be a number in (0, 1440]";
    }
    if (resultAggregation !== undefined && !RESULT_AGGREGATIONS.includes(resultAggregation)) {
      return `executionPolicy.resultAggregation must be one of ${RESULT_AGGREGATIONS.join(", ")}`;
    }
  }
  if (targetAgents !== undefined) {
    if (!Array.isArray(targetAgents) || targetAgents.length === 0 || !targetAgents.every((a) => typeof a === "string" && a.trim())) {
      return "targetAgents must be a non-empty array of agent ids";
    }
  }
  return null;
}

// ── Schedule math ────────────────────────────────────────────────────────────
// cron-parser is node-schedule's own expression parser, so occurrence math
// here always agrees with what the timer fires on.
function parseRule(cron, tz) {
  return cronParser.parseExpression(cron, { tz: tz || undefined });
}

// 时区可解析性。**用 ICU 判,不自建白名单**:`cron-parser` 的 CronDate 走的也是 ICU 时区库,
// 实测两者对 `"Shanghai"`(IANA 名是 `Asia/Shanghai`)给出同样的拒绝 ⇒ 这一处判据与引擎同源。
// 自建白名单会与引擎走散:白名单里有的引擎可能不认,反之亦然。
function validateTimezone(tz) {
  if (tz === undefined || tz === null || tz === "") return null;
  if (typeof tz !== "string") return "timezone must be an IANA timezone string (e.g. Asia/Shanghai)";
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return null;
  } catch {
    return `invalid timezone: ${tz} — needs an IANA zone name (e.g. Asia/Shanghai)`;
  }
}

function validateCron(cron, tz) {
  if (!cron || typeof cron !== "string") return "cron expression is required";
  try {
    parseRule(cron, tz);
    return null;
  } catch {
    // 解析失败时先问「是不是时区的错」。否则「表达式完全正确、坏的是时区」会被报成
    // `invalid cron expression: 00 09 * * *` —— 那个文案把人引向错误的方向(实测的存量任务就是这样)。
    const tzBad = validateTimezone(tz);
    if (tzBad) return tzBad;
    return `invalid cron expression: ${cron}`;
  }
}

// ── Interval rules (add-cron-automation-parity, design S2) ───────────────────
// An every-N interval is stored as the RULE, never coerced into a cron
// approximation: five-field cron cannot express "every 40 days". Occurrences
// are anchor + k × step, where the anchor is the acceptance time on the SERVER
// clock (a client-computed wall time would silently roll a year forward once
// it lands in the past). All four units (minute/hour/day/week) are pure
// durations — no time-of-day phase exists.
const INTERVAL_UNITS = new Set(["minute", "hour", "day", "week"]);
const UNIT_MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 };

function validateInterval(interval) {
  if (!interval || typeof interval !== "object") return "interval must be an object";
  const { number, unit } = interval;
  if (!Number.isInteger(number) || number < 1 || number > 200) return "interval.number must be an integer 1–200";
  if (!INTERVAL_UNITS.has(unit)) return "interval.unit must be one of minute|hour|day|week";
  return null;
}

// Next occurrence after `from`, anchored at `anchorIso`. Occurrences are
// anchor + k × step with k ≥ 1 — the anchor is the moment the rule STARTED,
// never an occurrence itself (firing at the anchor would mean an interval task
// ran the instant it was created).
function nextIntervalOccurrence(task, from = Date.now()) {
  const anchor = new Date(task.anchor || task.createdAt).getTime();
  const step = task.interval.number * UNIT_MS[task.interval.unit];
  if (from < anchor) return anchor + step;
  const k = Math.floor((from - anchor) / step) + 1;
  return anchor + k * step;
}

// Tolerance window for a downtime gap (P2 catch-up): the same shape the fleet
// presence derivation uses — 2 × cadence period, floored at 6h — computed here
// so cron.js stays free of the fleet layer. A gap older than this is past
// saving: the post would read `missing` anyway and a late patrol would only
// mislead. Unparseable rules fall back to the floor (never suppress a catch-up
// on a rule the scheduler itself accepted).
//
// The window math and the verdict itself are pure functions in
// server/cron-decisions.js (harden-cell-execution-reliability 3.1, pinned by
// scripts/test-cron-decisions.mjs); this wrapper owns only the inherently
// impure parts — the env kill switch, the cron-rule parse and the default
// clock. Verdict order stays: kill switch → unparseable rule (degrade open)
// → never ran → window compare (inclusive at the boundary).
function withinToleranceWindow(task, now = Date.now()) {
  const killSwitch = process.env.PLATFORM_CRON_CATCHUP === "0";
  let windowMs = null; // unparseable rule → null → the verdict degrades open
  if (!killSwitch) {
    try {
      const iter = cronParser.parseExpression(task.cron, { tz: task.tz || undefined });
      const a = iter.next().toDate();
      const b = iter.next().toDate();
      windowMs = catchUpWindowMs(b - a);
    } catch {
      // A rule the scheduler itself accepted failed to parse here: degrade
      // open — never suppress a catch-up on it.
    }
  }
  const lastMs = task.lastRun ? Date.parse(task.lastRun) : null;
  return withinCatchUpWindow({ killSwitch, windowMs, lastRunMs: lastMs, nowMs: now });
}

// Interrupted-beat makeup decision (add-rollout-gap-durability): a cron-sourced
// fleet run a pod roll killed already consumed its cadence beat (lastRun was
// stamped at fire time), so the boot downtime pass never sees this gap. One
// decision point, same tolerance rule as the boot pass, same engine fire path
// (catchUpPending marker + fireTask) — exported so the ledger wiring stays
// thin and the rule is pinned by tests rather than only exercised at boot.
// Verdicts: "makeup" | "no-task" | "outside-tolerance" | "kill-switch" | "deferred".
//
// DEFERRAL (2026-11-15 生产实证): the run-ledger sweep that calls this runs at
// server.js top level, BEFORE `cron.initCron` (the boot Promise.all at
// server.js:1779) has loaded any record — so `allRecords()` is empty, the
// lookup below finds nothing, and every real interrupted cron beat verdicts
// `no-task`. The sweep then CLOSES those headers, so the hourly follow-up never
// sees them again: the whole makeup path was dead on the one decision it ever
// gets. Logs prove it (`[fleet-runs] interrupted cron beat of run … not made up
// (no-task)`) while the post itself sits in jobs.json. When the engine is not
// loaded yet the request is PARKED by runId and decided by `drainPendingMakeups()`
// right after initCron resolves — "engine not ready" and "no such post" must not
// share a verdict, or the difference is invisible in the only log we keep.
const pendingMakeupBeats = new Map(); // runId → { fleetId, memberId }

// A makeup is only worth a real turn if it is not about to be superseded by the
// post's OWN next slot. 2026-11-15 生产实证（`m_1792910486604_bbkafz`，cell
// 3fdc7b8e）：补跑 12:13:07 起跑、常规轮 12:17:28 起跑 —— 同一岗位 261 秒内跑
// 两遍，第二遍踩在同一小时的槽位上，补出来的内容当场被覆盖；成本是双份预算。
// 窗口按「一次补跑大概要跑多久」取（缺省 10 分钟，比一轮实测 86–131s 宽裕），
// 可用 `PLATFORM_CRON_MAKEUP_SUPERSEDE_MIN` 调；`nextRun` 在 initCron 的排期
// pass 之后已刷新，所以这里读到的是本次启动真正要用的下一个槽位。
function makeupSupersedeMs() {
  const min = Number(process.env.PLATFORM_CRON_MAKEUP_SUPERSEDE_MIN ?? 10);
  return (Number.isFinite(min) ? min : 10) * 60_000;
}

function decideMakeupBeat({ fleetId, memberId, now = Date.now() }) {
  const task = engine
    .allRecords()
    .find((t) => t?.type === "recurring" && t?.sourceTag?.fleetId === fleetId && t?.sourceTag?.memberId === memberId);
  if (!task || task.paused) return "no-task";
  if (!withinToleranceWindow(task)) return "outside-tolerance";
  const nextAt = task.nextRun ? Date.parse(task.nextRun) : NaN;
  if (Number.isFinite(nextAt) && nextAt - now <= makeupSupersedeMs()) return "superseded";
  void fireTask(task.id, { catchUp: true });
  return "makeup";
}

function makeUpInterruptedBeat({ fleetId, memberId, runId = null }) {
  if (process.env.PLATFORM_CRON_CATCHUP === "0") return "kill-switch";
  if (!isEngineInitialized()) {
    if (runId) pendingMakeupBeats.set(runId, { fleetId, memberId });
    return "deferred";
  }
  return decideMakeupBeat({ fleetId, memberId });
}

// Decide every parked interruption now that the task list exists. Called once
// per boot, after initCron; returns per-verdict counts so the caller can log
// what actually happened instead of "ran without error".
function drainPendingMakeups() {
  const counts = { makeup: 0, "no-task": 0, "outside-tolerance": 0, "kill-switch": 0, superseded: 0 };
  for (const [runId, req] of pendingMakeupBeats) {
    pendingMakeupBeats.delete(runId);
    const verdict = makeUpInterruptedBeat(req); // engine is loaded here ⇒ no re-park
    counts[verdict] = (counts[verdict] ?? 0) + 1;
    if (verdict !== "makeup") {
      console.warn(`[cron] interrupted beat of run ${runId} not made up (${verdict})`);
    }
  }
  return counts;
}


// Count occurrences strictly between lastRun and now for a recurring task that
// was NOT running (load-time gap). Increments the missed counter and appends a
// history marker so the UI can show why a task skipped. Returns the number of
// occurrences recorded as missed (0 when the record did not change) — the
// caller persists, and the boot pass uses it to decide on a catch-up run
// (2026-10-26 P2: a downtime-covered trigger silently lost one delivery).
// The counting walk itself is the pure countMissedBetween
// (server/cron-decisions.js); what stays here is rule parsing, the record
// mutation and the reason stamping.
function countMissedOccurrences(task) {
  const now = new Date();
  const lastRunMs = task.lastRun ? Date.parse(task.lastRun) : NaN;
  if (!Number.isFinite(lastRunMs)) return 0;
  // ── 水位：同一个缺口只能记一次（2026-11-09 实测修复）──────────────────
  //
  // 原先从 `lastRun` 一路数到现在，而这个函数在**每次启动加载**（cron.js 顶）
  // 与**每次恢复**（resume）都会跑。于是一个 `lastRun` 停在昨天的 job，每次
  // cell 重启都会把同一批历史触发点再数一遍并累加：
  //   live 实测一个 `10 9 * * *`（每天一次）的 job，一天内 missed=69，
  //   其中 8 次集中在两小时里——而那两小时我正好滚了 4 次版。
  // 症状看起来像"排队饥饿"，实际是**我自己重启造成的假信号**；这个数同时被
  // health 巡检与队列读面当信号用，假一次就要误诊一次。
  //
  // 修法：记一个"已经统计到哪"的水位 `lastMissedCountedUntil`，只数水位之后
  // 的触发点。旧记录没有该字段时回落 `lastMissedAt`——它的语义正是"上次统计的
  // 时刻"，所以存量数据立刻停止膨胀，不必等下一次成功运行。
  const watermarkRaw = task.lastMissedCountedUntil ?? task.lastMissedAt ?? null;
  const watermarkMs = watermarkRaw ? Date.parse(watermarkRaw) : NaN;
  const fromMs = Math.max(
    lastRunMs,
    Number.isFinite(watermarkMs) ? watermarkMs : Number.NEGATIVE_INFINITY,
  );
  try {
    const iter = parseRule(task.cron, task.tz);
    const missed = countMissedBetween(iter, fromMs);
    if (missed > 0) {
      task.missed = (task.missed || 0) + missed;
      // Stamp the reason on the record so every surface that shows a task can
      // say WHY it skipped, not just that a counter moved (P2 visibility).
      task.lastMissedAt = now.toISOString();
      task.lastMissedCountedUntil = now.toISOString();
      task.lastMissedReason = "downtime";
      task.history = task.history || [];
      // 到期未执行是**独立一类**，不是失败（1.4）：写入方声明 kind，
      // 读方不必再猜这个形状（同一天里它被误读成失败过一次，89.7% 假失败率）。
      //
      // 一次加载最多数 MAX_MISSED_PER_LOAD 个触发点，碰到上限时这个数只是**下界**：
      // 水位照样推进到 now（宁愿少报也不重复记——重复记曾让我误诊"饥饿恶化"），
      // 于是超出上限的那截缺口永久不计。所以撞上限必须打标，否则读方会把
      // 「≥100」当成「正好 100」，而汇总里 starvationRatio 就成了假下界。
      const capped = missed >= MAX_MISSED_PER_LOAD;
      task.history.push({
        kind: "missed",
        time: now.toISOString(),
        missed,
        ...(capped ? { missedCapped: true } : {}),
        success: null,
      });
      console.log(
        `[cron] Task ${task.id} missed ${missed} occurrence(s) during downtime`
        + (capped ? " (hit the per-load cap: this is a floor, the rest of the gap is not counted)" : ""),
      );
      return missed;
    }
  } catch (err) {
    console.warn(`[cron] missed-count failed for ${task.id}: ${err.message}`);
  }
  return 0;
}

// 窗外丢轮显式告警（harden-cell-execution-reliability）：容差窗外的停机丢轮
// 在「只记账」之上必须显式告警——miss 计数行本身不算告警，静默吞掉被规格明令
// 禁止。通道纪律与计量链直读未配置告警先例（wire-metering-explicit-alerting）
// 一致：WARNING 明示、点名对象与数量。复用引擎既有的 WS 事件面（cron_* 事件
// 同缝）广播一条显式告警事件；任务记录上的 missed/lastMissedAt/lastMissedReason
// 仍是持久证据。暂停任务不告警（不跑是所有者的本意）；kill switch 下照告——
// 关掉的是补跑，不是知情权（reason 区分，运维可辨）。
function alertMissedBeats(task, missed) {
  const reason = process.env.PLATFORM_CRON_CATCHUP === "0" ? "catch-up-disabled" : "outside-tolerance";
  console.warn(`[cron] ALERT: task ${task.id} lost ${missed} beat(s) to downtime outside the catch-up window (${reason})`);
  engine.broadcastEvent({
    type: "cron_missed_alert",
    id: task.id,
    missed,
    reason,
    at: new Date().toISOString(),
  });
}

// ── Schedule management ──────────────────────────────────────────────────────

function generateId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// The fleet patrol-context renderer (agent-fleet-report-lane), injected by the
// server layer at init so this module stays fleet-agnostic and testable. Null
// when absent: fleet tasks then fire with their stored (template) prompt —
// the same behavior a deployment without the report lane keeps.
let renderFleetContextFn = null;

// Wire the renderer without a full initCron pass (tests, late mounting).
function setFleetContextRenderer(fn) {
  renderFleetContextFn = typeof fn === "function" ? fn : null;
}

// Is a renderer mounted? Callers that compose a per-fire prompt by hand need to
// know whether `{{fleetContext}}` will actually be expanded — if it will, they
// must LEAVE the placeholder alone (and not pre-bake a segment of their own).
function hasFleetContextRenderer() {
  return typeof renderFleetContextFn === "function";
}

// The delivery lane's decision, in one place (fix-decision-delivery-context):
// a hand-composed per-fire prompt that still carries `{{fleetContext}}` must
// leave it ALONE when a renderer is mounted — the seam expands it, and the
// decision digest arrives inside that segment. Without a renderer nothing will
// expand it, so the caller must pre-bake whatever the turn needs.
function keepFleetContextPlaceholder(prompt) {
  return typeof prompt === "string" && prompt.includes("{{fleetContext}}") && hasFleetContextRenderer();
}

// 舰队巡逻上下文注入 —— 现在是**执行侧注入缝的实现**（fix-fleet-context-
// injection-seam），不再是入队前的写手。
//
// 为什么搬家：入队路径有四条（定时开火、补跑开火、手动立即执行、平台重启后
// 恢复持久化 queued 任务），注入原本散写在入队侧，于是漏了两次——2026-10-29
// 手动戳发绕过（CEO 一轮 prompt 只有 249 字符），2026-10-30 恢复通道绕过
// （补跑轮 283 字符、`{{fleetContext}}` 原样没展开）。引擎的
// runExecutionTurn 是四条路径唯一的汇合点，缝设在那里，第五条路径出现时也
// 天然覆盖。
//
// 组合规则（两处既证缺陷一并根治）：
//   base   = task.promptOverride ?? task.prompt（保留决策送达等既有覆写）
//   prefix = task.catchUpPending ? 【补跑】 : ""
//   占位符在 → 替换为渲染段；不在 → 跳过（不双注入）
//   final  = prefix + base
// 补跑前缀改由 catchUpPending 标志在缝内组合——它以前是入队前预写进
// promptOverride 的，会被这里的整体替换吃掉（正常补跑丢前缀），或与恢复通道
// 竞态时反过来丢掉上下文。标志是既有的（结算时清除），无需新字段。
//
// 渲染失败/空段**抛错**：由 runExecutionTurn 的 catch 落成该次执行的 failed，
// 绝不静默按裸模板跑一轮。
async function composeFleetPrompt(task) {
  const basePrompt = task.promptOverride ?? task.prompt;
  const prefix = task.catchUpPending
    ? "【补跑】上一轮因平台停机被跳过，本次为补跑（正常节奏不受影响）。\n\n"
    : "";
  const isFleet = Boolean(fleetTagOf(task));
  const promptStr = typeof basePrompt === "string" ? basePrompt : "";
  // Two placeholder families (add-fleet-edge-context D1): the cadence template
  // asks for the patrol rendering ({{fleetContext}}), the four hand-built edge
  // prompts ask for the compact one ({{fleetEdgeContext}}). Same seam, two
  // shapes — because a patrol segment ends with "先报数再补充" discipline that
  // would actively misdirect a dispatched/handed-off turn.
  const wantsPatrol = promptStr.includes("{{fleetContext}}");
  const wantsEdge = promptStr.includes("{{fleetEdgeContext}}");
  // Non-fleet task, or a prompt composed elsewhere already (decision delivery
  // overwrites with a placeholder-free prompt): nothing to render.
  if (!isFleet || (!wantsPatrol && !wantsEdge)) {
    if (prefix) engine.setPromptOverride(task.id, `${prefix}${basePrompt ?? ""}`);
    return;
  }
  if (!renderFleetContextFn) {
    // No renderer mounted (a deployment without the report lane): keep the
    // historical behavior — fire with the stored template, never fail the run.
    if (prefix) engine.setPromptOverride(task.id, `${prefix}${basePrompt}`);
    return;
  }
  const render = async (mode) => {
    let segment;
    try {
      segment = await renderFleetContextFn(task.sourceTag, task, mode ? { mode } : undefined);
    } catch (err) {
      throw new Error(`fleetContext render failed: ${err?.message || err}`);
    }
    if (typeof segment !== "string" || !segment.trim()) {
      throw new Error("fleetContext renderer returned an empty segment");
    }
    return segment;
  };
  let out = promptStr;
  if (wantsPatrol) {
    const segment = await render("patrol");
    // Function replacer: the segment carries report text, and a string
    // replacement would let `$&`/`$'` inside it rewrite the prompt.
    out = out.replace(/\{\{fleetContext\}\}/g, () => segment);
  }
  if (wantsEdge) {
    const segment = await render("edge");
    out = out.replace(/\{\{fleetEdgeContext\}\}/g, () => segment);
  }
  engine.setPromptOverride(task.id, `${prefix}${out}`);
}

// One trigger of an armed task. Prompt shaping (fleet context, catch-up prefix)
// no longer happens here — it happens in the engine's pre-turn seam, which this
// module implements above — so every enqueue path gets it.
async function fireTask(id, opts = {}) {
  const task = engine.getRecord(id);
  if (!task) return;
  engine.enqueueExecution(id, opts);
}

// Arm the live timer on the engine's shared record (in place — the record IS
// the engine's map entry; copying would detach state transitions from it).
function scheduleJob(task) {
  if (task.paused) return task;
  // A capped task that already ran out never re-arms (spec: 跑满即 completed).
  if (task.maxRuns != null && (task.runs ?? 0) >= task.maxRuns) {
    task.status = "completed";
    return task;
  }
  try {
    // Interval tasks arm ONE occurrence at a time (a Date), because an every-N
    // rule can exceed what a five-field cron can express; the next Date is
    // recomputed from the rule on every finish (refreshNextRun).
    const spec =
      task.interval
        ? new Date(nextIntervalOccurrence(task))
        : task.type === "recurring" && task.cron
          ? (task.tz ? { rule: task.cron, tz: task.tz } : task.cron)
          : new Date(task.when);
    task.job = schedule.scheduleJob(spec, () => {
      void fireTask(task.id);
    });
    // node-schedule 对解不开的 rule/tz **不抛错**：返回 false、nextInvocation()
    // 为 null（实测 tz="Shanghai" / "GMT+8" / "Z" 全是这个形状）。若只看
    // `task.job?.nextInvocation()` 跳过，任务就停在 "scheduled"、arm「成功」
    // 却永不触发 —— 线上 job_1793545719158_u4ar00（tz="Shanghai"，末次执行
    // 2026-11-07 后 7 天一条不跑）即此形。写路径的 validateTimezone 只拦新
    // 写入，存量坏值每次重启都会走到这里被静默吞掉 ⇒ arm 出不来下一次触发
    // 就是坏调度，必须抛给下方的 catch 落成 status:"error"（落盘可见）。
    const nextInvocation = task.job?.nextInvocation();
    if (nextInvocation) {
      task.nextRun = nextInvocation.toISOString();
      // 可逃逸性：error 是「这次 arm 失败」的状态，不是身份。所有者修好成因
      // （updateJob 改 tz 等）走的就是这条成功路 ⇒ 陈旧的 error 必须清掉，
      // 否则读面对着一个健康的排期永远报错（①⑤ 成对守卫）。
      if (task.status === "error") {
        task.status = "scheduled";
        task.error = null;
      }
    } else {
      const tzBad = validateTimezone(task.tz);
      const tzHint = tzBad ? ` — tz "${task.tz}" ${tzBad}` : "";
      throw new Error(
        `scheduler armed nothing: no next invocation exists, the task would never fire${tzHint}`,
      );
    }
  } catch (err) {
    console.error(`[cron] Failed to schedule task ${task.id}:`, err.message);
    task.status = "error";
    task.error = err.message;
    // scheduleJob 失败时 node-schedule 可能留下一个 falsy 句柄（false）——
    // refreshNextRun 的 `task.job?.nextInvocation()` 对 false 不会短路
    // （false 非 nullish），会把 `false.nextInvocation()` 读成 undefined
    // 再调用而抛 TypeError。清成 null，让所有 `task.job?.` 的读法短路成立。
    task.job = null;
  }
  return task;
}

// The engine calls this after each finished execution so recurring tasks show
// the next armed occurrence.
function refreshNextRun(task) {
  if (task.job?.nextInvocation()) {
    task.nextRun = task.job.nextInvocation().toISOString();
  }
}

// Interval + finite-run lifecycle (add-cron-automation-parity, design S2/S4;
// finite-run cap extended to cron by fix-cron-maxruns-on-recurring).
//
// Spec `cron-module` "Finite runs close themselves out" says a recurring task
// with a maximum run count SHALL count completed scheduled executions and
// transition to `completed` on reaching the cap — for ANY recurring form.
// The old guard returned on `!task.interval`, so a cron cap was accepted at
// creation (validateCron allows maxRuns with cron) and then never counted:
// live 2026-11-14, job_1793545719158_u4ar00 declared maxRuns:1, had five rounds
// in its history, and its counter still read 0. An accepted cap that is never
// enforced is a promise the platform silently drops, so the two forms share one
// counting path.
//
// Counting stays limited to tasks that DECLARE a cap: advancing `runs` on every
// recurring task would rewrite persisted records for no reader (`saveTasks`
// only emits maxRuns/runs when maxRuns != null anyway).
//
// Re-arming remains the interval path's business. A cron handle repeats by
// itself, so calling scheduleJob here would arm a SECOND timer for one task —
// exactly the duplicate-rhythm shape the fleet reconcile now collapses.
function onIntervalFinished(task) {
  if (!task) return;
  const capped = task.maxRuns != null;
  if (!task.interval && !capped) return;
  // Seeding from `history` was rejected: a history row does not establish the
  // counter's prior value, and seeding it could retire a task that never
  // actually completed its declared rounds (see the change's 口径决定).
  task.runs = (task.runs ?? 0) + 1;
  if (capped && task.runs >= task.maxRuns) {
    task.status = "completed";
    if (task.job) {
      try {
        task.job.cancel();
      } catch {
        /* already gone */
      }
      task.job = null;
    }
    task.nextRun = null;
    return;
  }
  // Only intervals re-arm from the rule; cron keeps its repeating handle.
  if (task.interval && !task.paused && task.status !== "expired") scheduleJob(task);
}

// fix-cron-preset-shape: ONE predicate, used by BOTH faces that can bind a
// target (addJob and updateJob). The edit face had the same hole — its rebind
// branch writes `targetType: "persona"` with `preset` verbatim, so a job could
// be created correctly and then re-pointed into the shape the executor rejects.
// (Same class as every other "creation face validates, edit face does not" bug.)
//
// The predicate is `::` alone, safe by construction: runtime persona ids are
// `[a-z0-9-]` only, so no real persona can carry it.
function assertPresetShape({ preset, tool }) {
  if (tool === undefined && typeof preset === "string" && preset.includes("::")) {
    throw new Error(
      `preset '${preset}' looks like a tool reference — pass it as \`tool\` instead; \`prompt\` is the tool's JSON arguments`,
    );
  }
}

async function addJob({
  cron,
  when,
  prompt,
  preset,
  agent,
  tool,
  tz,
  sessionTitle,
  clusterId,
  clusterName,
  agentCount,
  executionPolicy,
  targetAgents,
  sourceTag,
  projectId,
  carrier,
  packId,
  concurrency,
  workbench,
  // 岗位级顶替豁免（3.2 的 manifest 入口）：不声明 = false = 可被顶替，
  // 与加入本字段之前逐字节一致。谁该豁免是业务配置，代码只负责把声明送到记录上。
  noSupersede,
  // add-cron-automation-parity: the two new schedule forms + the finite cap.
  delayMinutes,
  interval,
  maxRuns,
}) {
  // ── Schedule-form validation (exactly one form) ──────────────────────────
  // A relative one-shot is resolved HERE, from the server's own clock — a
  // client-computed wall time could land in the past and silently roll a year
  // forward (design S3). The stored task keeps the resolved absolute `when`.
  if (delayMinutes !== undefined) {
    if (!Number.isInteger(delayMinutes) || delayMinutes < 1 || delayMinutes > 525600) {
      throw new Error("delayMinutes must be an integer between 1 and 525600");
    }
    if (cron || when || interval) throw new Error("delayMinutes is exclusive with cron/when/interval");
    when = new Date(Date.now() + delayMinutes * 60_000).toISOString();
  }
  if (interval !== undefined) {
    const bad = validateInterval(interval);
    if (bad) throw new Error(bad);
    if (cron || when) throw new Error("interval is exclusive with cron/when");
  }
  if (maxRuns !== undefined) {
    if (!Number.isInteger(maxRuns) || maxRuns < 1) throw new Error("maxRuns must be a positive integer");
    // A cap only means something on a repeating form.
    if (!cron && !interval) throw new Error("maxRuns requires a recurring form (cron or interval)");
  }

  // 时区**一旦提供就校验**,不看这次有没有带 cron。原先只在 `if (cron)` 分支里校,
  // 于是「只改时区」这条最自然的编辑路径完全绕过它(见 fix-cron-tz-edit-validation)。
  {
    const tzInvalid = validateTimezone(tz);
    if (tzInvalid) throw new Error(tzInvalid);
  }
  if (cron) {
    const invalid = validateCron(cron, tz);
    if (invalid) throw new Error(invalid);
  } else if (interval) {
    // validated above
  } else if (!when || Number.isNaN(new Date(when).getTime())) {
    throw new Error("a valid cron expression, interval, delay, or one-shot time is required");
  }
  if (!prompt || typeof prompt !== "string") throw new Error("prompt is required");

  // Cluster binding (agent-cluster-platform): a task targets a persona OR a
  // cluster — the cluster ref rides `preset` so target-ref semantics stay
  // uniform, and the human label/count persist beside it for list views.
  const isClusterTask = Boolean(clusterId);
  if (isClusterTask && preset) {
    throw new Error("a task targets a preset OR a cluster, not both");
  }
  // Market a2a target (agent-fleet-core): same dichotomy as the manual
  // trigger's persona/agent pair — a scheduled a2a post fires remote turns.
  if (agent && preset) {
    throw new Error("a task targets a preset OR a market agent, not both");
  }
  if (agent && isClusterTask) {
    throw new Error("a task targets a cluster OR a market agent, not both");
  }
  if (agent !== undefined && typeof agent !== "string") {
    throw new Error("agent must be a market agent id string");
  }
  if (sourceTag !== undefined && sourceTag !== null) {
    if (typeof sourceTag !== "object" || Array.isArray(sourceTag)) {
      throw new Error("sourceTag must be an object");
    }
  }
  if (clusterName !== undefined && typeof clusterName !== "string") {
    throw new Error("clusterName must be a string");
  }
  if (agentCount !== undefined && (!Number.isInteger(agentCount) || agentCount < 1)) {
    throw new Error("agentCount must be a positive integer");
  }
  // fix-cron-preset-shape: the OTHER half of "the creation face must agree with
  // the execution face". `preset` is normalized verbatim, and without `tool` the
  // record is classified `targetType: "persona"` — so a `server::tool` value
  // written into `preset` produced a scheduled job that died at the executor
  // every fire with `Unknown agent preset: <id>`. Measured 2026-11-14 (cell
  // 1da519d4c1c0bf89, member_turn_events): 12 `source=cron` rows, latest
  // 2026-11-13T03:05:45Z. No caller in this repo passes that shape
  // (`grep -rn "preset:.*::"` → 0), so the caller is outside the repo — which is
  // exactly why the refusal has to live here and not at a call site.
  //
  // The predicate is `::` alone, safe by construction: runtime persona ids are
  // `[a-z0-9-]` only (dsh-profile's roster rule), so no real persona can carry it.
  assertPresetShape({ preset, tool });
  // Tool posts: the prompt IS the tool's arguments, so it must parse as a JSON
  // object. Rejected HERE rather than at turn time (fix-cell-turn-throughput
  // 4.1) — 2026-11-08 live had 4 tasks failing every fire with
  // "tool post promptTemplate must be a JSON object": a deterministic
  // misconfiguration no retry could ever fix.
  if (tool) {
    let parsedArgs = null;
    try {
      parsedArgs = JSON.parse(prompt ?? "");
    } catch {
      parsedArgs = null;
    }
    if (!parsedArgs || typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) {
      throw new Error(
        "tool post prompt must be a JSON object — it is the tool's arguments (e.g. {\"query\":\"…\"})",
      );
    }
  }
  const policyInvalid = validateClusterPolicy({ executionPolicy, targetAgents });
  if (policyInvalid) throw new Error(policyInvalid);

  // 时区**一旦提供就校验**,且必须发生在下面 `task.tz = …` 落盘之前。
  // 原先它只在 `if (cron !== undefined)` 分支里被 `validateCron(cron, tz ?? task.tz)` 顺带校到,
  // 因此「只改时区、不动表达式」会把不可解的值直接写进去,任务随后静默停摆
  // (线上 job_1793545719158_u4ar00:tz="Shanghai"、末次执行 2026-11-07,此后 7 天一条不跑)。
  {
    const tzInvalid = validateTimezone(tz);
    if (tzInvalid) throw new Error(tzInvalid);
  }

  const id = generateId();
  const taskData = {
    id,
    trigger: "schedule",
    type: cron || interval ? "recurring" : "once",
    cron,
    when,
    // Schedule-form extras (add-cron-automation-parity): the interval rule is
    // the truth (never a coerced cron), the anchor is when the rule started,
    // and maxRuns/runs are the finite-run counter pair. All absent on legacy
    // cron/once records → same semantics as before.
    ...(interval ? { interval: { number: interval.number, unit: interval.unit }, anchor: new Date().toISOString() } : {}),
    ...(maxRuns != null ? { maxRuns, runs: 0 } : {}),
    prompt,
    // Binding: the persona the task runs under and the session its output
    // belongs to. sessionId is minted here so the id is stable from creation,
    // but the dsh/SQLite session itself is only created at first execution
    // (a paused or deleted task leaves no orphan session behind).
    preset: isClusterTask ? clusterId : (preset ?? agent ?? tool ?? null),
    // tool posts (add-tool-posts): preset is the "server::tool" target — a
    // deterministic MCP call, no dsh runtime.
    targetType: isClusterTask ? "cluster" : agent ? "a2a" : tool ? "tool" : "persona",
    // Turn carrier (add-fleet-carrier): the placement dimension rides the task
    // — cell | worker | runner | auto (null = unset → auto). Dispatch and the
    // remote router read it; the engine never invents values.
    carrier: carrier ?? null,
    packId: packId ?? null,
    // 并行份数与工作台（fleet-run-concurrency 4.4）：随物化 spec 进任务记录，
    // 与 carrier 同款——null = 未声明，resolver 落到舰队/部署层。
    concurrency: Number.isInteger(concurrency) ? concurrency : null,
    workbench: workbench ?? null,
    ...(isClusterTask
      ? {
          clusterId,
          clusterName: clusterName || null,
          agentCount: typeof agentCount === "number" ? agentCount : null,
          executionPolicy: executionPolicy ?? null,
          targetAgents: targetAgents ?? null,
        }
      : {}),
    sessionId: `cron-${id}`,
    sessionTitle: sessionTitle || null,
    tz: tz || null,
    status: "scheduled",
    paused: false,
    createdAt: new Date().toISOString(),
    lastRun: null,
    nextRun: null,
    missed: 0,
    history: [],
    // Owning front-end tag (agent-fleet-core) — opaque passthrough.
    sourceTag: sourceTag ?? null,
    // 只有显式 true 才豁免；缺省/undefined 一律 false（不落噪声字段进记录）。
    ...(noSupersede === true ? { noSupersede: true } : {}),
    // Project attribution (add-web-project-container) — opaque passthrough to
    // the read surfaces; NULL = the 默认项目 bucket. The engine never reads it.
    projectId: projectId ?? null,
  };

  // insertTask validates the target (engine SUPPORTED_TARGET_TYPES: persona,
  // a2a, cluster, tool) before anything is scheduled or persisted.
  const record = engine.insertTask(taskData);
  scheduleJob(record);
  await engine.saveTasks();
  engine.broadcastStatus(id);
  // Return the client-facing shape, never the live record: it carries the
  // node-schedule Job handle (a circular object), and the WS reply serializes
  // this value.
  return engine.getTask(id);
}

// In-place update of a schedule task (agent-fleet-core reconcile): cadence
// edits and incumbent swaps REWRITE the existing record — the task id (and
// with it the dedicated session id and execution history) must survive the
// change, so remove-then-add is not an option. Only provided fields apply;
// target rebinding accepts the same target trio as addJob and clears the
// previous binding's residual fields.
async function updateJob(id, changes = {}) {
  const task = engine.getRecord(id);
  if (!task) return null;
  if (task.trigger !== "schedule") {
    throw new Error("only schedule tasks can be updated in place");
  }

  const { cron, when, prompt, tz, sessionTitle, preset, agent, tool, clusterId, clusterName, agentCount, executionPolicy, targetAgents, sourceTag, delayMinutes, interval, maxRuns, carrier, packId, concurrency, workbench, noSupersede } = changes;

  if (cron !== undefined) {
    if (!cron || typeof cron !== "string") throw new Error("cron must be a non-empty string");
    const invalid = validateCron(cron, tz ?? task.tz);
    if (invalid) throw new Error(invalid);
  }
  // add-cron-automation-parity: schedule-form changes. A relative one-shot is
  // resolved on the SERVER clock (same discipline as create), and an interval
  // rule is validated here; the three forms stay mutually exclusive.
  if (delayMinutes !== undefined) {
    if (!Number.isInteger(delayMinutes) || delayMinutes < 1 || delayMinutes > 525600) {
      throw new Error("delayMinutes must be an integer between 1 and 525600");
    }
    if (cron !== undefined || interval !== undefined || when !== undefined) {
      throw new Error("delayMinutes is exclusive with cron/when/interval");
    }
  }
  if (interval !== undefined) {
    const bad = validateInterval(interval);
    if (bad) throw new Error(bad);
    if (cron !== undefined) throw new Error("interval is exclusive with cron");
  }
  if (maxRuns !== undefined && (!Number.isInteger(maxRuns) || maxRuns < 1)) {
    throw new Error("maxRuns must be a positive integer");
  }
  if (when !== undefined && when !== null && Number.isNaN(new Date(when).getTime())) {
    throw new Error("when must be a valid time");
  }
  if (prompt !== undefined && (!prompt || typeof prompt !== "string")) {
    throw new Error("prompt must be a non-empty string");
  }
  if (sourceTag !== undefined && sourceTag !== null) {
    if (typeof sourceTag !== "object" || Array.isArray(sourceTag)) {
      throw new Error("sourceTag must be an object");
    }
  }
  const policyInvalid = validateClusterPolicy({ executionPolicy, targetAgents });
  if (policyInvalid) throw new Error(policyInvalid);

  // 时区**一旦提供就校验**,且必须发生在下面 `task.tz = …` 落盘之前。
  // 原先它只在 `if (cron !== undefined)` 分支里被 `validateCron(cron, tz ?? task.tz)` 顺带校到,
  // 因此「只改时区、不动表达式」会把不可解的值直接写进去,任务随后静默停摆
  // (线上 job_1793545719158_u4ar00:tz="Shanghai"、末次执行 2026-11-07,此后 7 天一条不跑)。
  {
    const tzInvalid = validateTimezone(tz);
    if (tzInvalid) throw new Error(tzInvalid);
  }

  // Target rebinding: at most one flavor among the trio.
  const targets = [preset, agent, tool, clusterId].filter((v) => v !== undefined);
  if (targets.length > 1) {
    throw new Error("a task targets a preset OR a cluster OR a market agent OR a tool, not several");
  }

  // Same shape rule as addJob — a rebind to a `::` preset without `tool` would
  // otherwise rewrite a healthy job into the shape the executor rejects.
  assertPresetShape({ preset, tool });

  // 换形态必须真的换掉。`addJob` 让三种形态互斥（`interval is exclusive with
  // cron/when`），但 `scheduleJob` 取值时 `task.interval` 排在 `task.cron` 前面 ——
  // 于是「先建成 interval、后改成 cron」若只写 cron，旧 interval 继续生效，新表达式
  // 只留在记录上（列表页读的就是它）⇒ 面板显示新排期、实际按旧间隔跑，两端各自自洽。
  // 与 maxRuns、tz 同族：入口接受、执行面不认。写面只产出 `addJob` 也会接受的形状。
  // ── 预检：更新后的记录必须是 `addJob` 会接受的形状 ────────────────────────────
  // 两件事一起修：
  // ① 创建面把几条**跨字段**约束校死了，编辑面只校「这次传入的那个字段」，于是同一条
  //    约束都能靠「先建个合法的、再改成非法的」绕过去。2026-11-14 实测三处：
  //    · tool 任务的 prompt 必须是 JSON 对象（fix-cell-turn-throughput 4.1：2026-11-08
  //      线上 4 条任务每次触发都失败在这上面，重试永远救不了）——改成一句普通文字会被接受，
  //      从下一次触发起每次必败；
  //    · `maxRuns` 只对循环形态有意义——给单次任务设上限会被接受，而上限永不生效；
  //    · `delayMinutes` 与 `when` 互斥——两者同时给出时 `when` 被静默覆盖（上面已拦）。
  // ② **校验必须在改动记录之前**。`updateJob` 拿到的 `task` 就是引擎的活记录本体
  //    （原地改，不是副本），所以「先 `task.prompt = prompt` 再抛错」会把被拒的编辑留在
  //    内存里——盘上没写，但那条记录已经变了，别的路径一次 `saveTasks` 就会把它写下去。
  //    实见：tool 任务被拒的 prompt 编辑之后，`getRecord().prompt` 已是那串非法文本。
  //    因此这里用**预期值**判，判完才进下面的赋值段。
  // 每条只在**它相关的那部分被改动**时才判：存量记录不该因为一次无关编辑被拦下
  // （tz 变更刻意不改写存量坏值，这里同一条纪律）。
  const prospectiveTargetType =
    targets.length === 1
      ? clusterId !== undefined
        ? "cluster"
        : agent !== undefined
          ? "a2a"
          : tool !== undefined
            ? "tool"
            : "persona"
      : task.targetType;
  if ((prompt !== undefined || tool !== undefined) && prospectiveTargetType === "tool") {
    const prospectivePrompt = prompt !== undefined ? prompt : task.prompt;
    let parsedArgs = null;
    try {
      parsedArgs = JSON.parse(prospectivePrompt ?? "");
    } catch {
      parsedArgs = null;
    }
    if (!parsedArgs || typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) {
      throw new Error(
        "tool post prompt must be a JSON object — it is the tool's arguments (e.g. {\"query\":\"…\"})",
      );
    }
  }
  const prospectiveRecurring =
    cron !== undefined || interval !== undefined
      ? true
      : when !== undefined || delayMinutes !== undefined
        ? false
        : Boolean(task.cron || task.interval);
  if (maxRuns !== undefined && !prospectiveRecurring) {
    throw new Error("maxRuns requires a recurring form (cron or interval)");
  }
  // Same shape rule as addJob — a rebind to a `::` preset without `tool` would
  // otherwise rewrite a healthy job into the shape the executor rejects.
  // （干线 `720c8e3fb` 独立发现了同一个洞的 `preset` 那一面。刻意并进这段预检、
  //   而不是留在赋值之后：它一旦抛错，下面的 `task.cron` 已经把活记录改掉了 ——
  //   那正是本段注释 ② 说的形态。）
  assertPresetShape({ preset, tool });

  if (cron !== undefined) {
    task.cron = cron;
    task.interval = null;
    task.anchor = null;
  }
  if (when !== undefined) {
    task.when = when;
    task.interval = null;
    task.anchor = null;
  }
  if (delayMinutes !== undefined) {
    // Resolve NOW, on the server clock — the stored task keeps the absolute
    // time so a restart never re-anchors it (design S3).
    task.when = new Date(Date.now() + delayMinutes * 60_000).toISOString();
    task.cron = null;
    task.interval = null;
    task.anchor = null;
  }
  if (interval !== undefined) {
    // A rule change re-anchors from now and clears the cron form/step counter.
    task.interval = { number: interval.number, unit: interval.unit };
    task.anchor = new Date().toISOString();
    task.cron = null;
    task.when = null;
    task.runs = 0;
  }
  if (maxRuns !== undefined) {
    task.maxRuns = maxRuns;
    // Lowering the cap below what already ran retires the task immediately
    // (spec: 改 cap 低于已跑数则即刻 completed).
    if ((task.runs ?? 0) >= maxRuns) task.status = "completed";
  }
  if (prompt !== undefined) task.prompt = prompt;
  // Turn carrier (add-fleet-carrier): placement-only drift — the task id, its
  // bound session and execution history survive (换身体不换会话).
  if (carrier !== undefined) task.carrier = carrier ?? null;
  if (packId !== undefined) task.packId = packId ?? null;
  // 并行份数与工作台（fleet-run-concurrency 4.4）：配置原位改写，任务 id / 会话 /
  // 执行历史都不动（与 carrier 同款）。
  if (concurrency !== undefined) task.concurrency = Number.isInteger(concurrency) ? concurrency : null;
  if (workbench !== undefined) task.workbench = workbench ?? null;
  // 豁免可被就地改回（reconcile 的 drift 修正）：false 要真的删掉这个键，
  // 否则记录上留一个 `noSupersede: false`，读的人会以为"声明过但没生效"。
  if (noSupersede !== undefined) {
    if (noSupersede === true) task.noSupersede = true;
    else delete task.noSupersede;
  }
  if (tz !== undefined) task.tz = tz || null;
  if (sessionTitle !== undefined) task.sessionTitle = sessionTitle || null;
  if (sourceTag !== undefined) task.sourceTag = sourceTag ?? null;
  if (cron !== undefined || when !== undefined) {
    task.type = task.cron || task.interval ? "recurring" : "once";
  }

  if (targets.length === 1) {
    // Clear the outgoing binding's residual fields before writing the new
    // one — a cluster→persona swap must not leave clusterId riding along
    // (the engine reads clusterId as the binding when present).
    task.clusterId = null;
    task.clusterName = null;
    task.agentCount = null;
    task.executionPolicy = null;
    task.targetAgents = null;
    if (clusterId !== undefined) {
      task.targetType = "cluster";
      task.preset = clusterId;
      task.clusterId = clusterId;
      if (clusterName !== undefined) task.clusterName = clusterName || null;
      if (agentCount !== undefined) task.agentCount = typeof agentCount === "number" ? agentCount : null;
      if (executionPolicy !== undefined) task.executionPolicy = executionPolicy ?? null;
      if (targetAgents !== undefined) task.targetAgents = targetAgents ?? null;
    } else if (agent !== undefined) {
      task.targetType = "a2a";
      task.preset = agent;
    } else if (tool !== undefined) {
      task.targetType = "tool";
      task.preset = tool;
    } else {
      task.targetType = "persona";
      task.preset = preset ?? null;
    }
  } else if (clusterName !== undefined || agentCount !== undefined || executionPolicy !== undefined || targetAgents !== undefined) {
    // Metadata-only touch-up without rebinding (cluster labels/policy).
    if (clusterName !== undefined) task.clusterName = clusterName || null;
    if (agentCount !== undefined) task.agentCount = typeof agentCount === "number" ? agentCount : null;
    if (executionPolicy !== undefined) task.executionPolicy = executionPolicy ?? null;
    if (targetAgents !== undefined) task.targetAgents = targetAgents ?? null;
  }

  // Re-arm the live handle under the new schedule (paused tasks stay parked —
  // the paused bit is owned by the reconcile layer, never flipped here).
  // Interval rows re-arm through scheduleJob (next occurrence recomputed from
  // the stored rule; spec: an update changing the schedule recomputes the next
  // occurrence from the new form). Without this branch the cancel below killed
  // an interval task's timer for good on ANY in-place update.
  if (task.job) {
    task.job.cancel();
    task.job = null;
  }
  if (!task.paused) {
    if (task.type === "recurring" && (task.cron || task.interval)) {
      scheduleJob(task);
    } else if (task.type === "once" && task.when) {
      const scheduledAt = new Date(task.when);
      if (scheduledAt > new Date()) {
        scheduleJob(task);
      } else {
        task.status = "expired";
      }
    }
  }

  await engine.saveTasks();
  engine.broadcastStatus(id);
  return engine.getTask(id);
}

async function removeJob(id) {
  const task = engine.getRecord(id);
  if (!task) return false;
  if (task.job) {
    task.job.cancel();
  }
  engine.deleteRecord(id);
  await engine.saveTasks();
  // Shape kept from the pre-engine module so client stores can drop the row.
  engine.broadcastEvent({ type: "cron_removed", id });
  return true;
}

async function pauseJob(id, options = {}) {
  const task = engine.getRecord(id);
  if (!task) return false;
  // Manual (delegated) tasks have no schedule-side lifecycle — pause/resume
  // are schedule concepts and SHALL NOT apply (spec: task-engine).
  if (task.trigger === "manual") return false;
  if (task.job) {
    task.job.cancel();
    task.job = null;
  }
  task.paused = true;
  // Pause SOURCE (fix-fleet-operator-pause-durability): an owner's stop and the
  // fleet reconcile's own parking are two layers. Reconcile resumes on
  // `desiredPaused` alone, so before this field an owner's pause on a member
  // task came back minutes after the next catalog refresh with nobody touching
  // it (2026-11-10 live, measured). Default "fleet" keeps every pre-existing
  // caller — reconcile calls pauseJob bare — at the old shape.
  task.pausedBy = options.by === "operator" ? "operator" : "fleet";
  task.status = "paused";
  await engine.saveTasks();
  engine.broadcastStatus(id);
  return true;
}

async function resumeJob(id) {
  const task = engine.getRecord(id);
  if (!task || !task.paused) return false;
  if (task.trigger === "manual") return false;
  task.paused = false;
  // An explicit resume clears the source: from here on the fleet's converge
  // pass owns the decision again (fix-fleet-operator-pause-durability).
  task.pausedBy = null;
  task.status = "scheduled";
  // Reschedule — interval rows re-arm through scheduleJob too (the rule's next
  // occurrence is recomputed from the anchor grid; spec: on resume a recurring
  // task continues from the next future occurrence).
  if (task.type === "recurring" && (task.cron || task.interval)) {
    if (task.cron) {
      // 恢复时同样不把暂停窗口算成缺口：那段时间没跑是所有者按下的暂停。
      // 把水位推到 now，等于"暂停期间的触发点不欠"，之后再积累的才计数。
      task.lastMissedCountedUntil = new Date().toISOString();
      countMissedOccurrences(task);
    }
    scheduleJob(task);
  } else if (task.type === "once" && task.when) {
    const scheduledAt = new Date(task.when);
    if (scheduledAt > new Date()) {
      scheduleJob(task);
    } else {
      task.status = "expired";
    }
  }
  await engine.saveTasks();
  engine.broadcastStatus(id);
  return true;
}

// Run or re-run a task immediately (bypasses the schedule). Returns the
// engine's enqueue result: { ok, already?, state?, error? } — already-queued
// or running executions are a no-op carrying the current state, and re-run of
// a failed/interrupted execution is allowed.
//
// 手动触发不再自己做注入：它和定时、补跑、重启恢复一样，起轮时经过引擎的
// pre-turn 缝（见 composeFleetPrompt）。这条路径曾两次成为「注入被绕过」的
// 现场（2026-10-29 手动、2026-10-30 恢复），现在缝在汇合点，路径再增也不漏。
async function runJobNow(id) {
  const task = engine.getRecord(id);
  if (!task) return engine.runTaskNow(id);
  return engine.runTaskNow(id);
}

// Readiness retry ladder (2026-11-08): re-enqueue the SAME round after a delay
// instead of losing it. Thin passthrough — the engine owns the record and the
// serialized queue; this module owns the scheduling surface.
function reenqueueJob(id, delayMs) {
  return engine.scheduleReenqueue(id, delayMs);
}

function listJobs() {
  return engine.listTasks();
}

// Engine readiness passthrough (agent-fleet-core): the fleet reconcile hook on
// catalog changes must not race the engine's load-time map replacement.
function isEngineInitialized() {
  return engine.isInitialized();
}

function getJob(id) {
  return engine.getTask(id);
}

function getDashboardState() {
  return engine.getDashboardState();
}

// ── Interrupted-execution turn events (fix-interrupted-turn-event-on-restart) ─
//
// The engine's load-time rewrite (running → interrupted) happens before any
// database exists, and the execution never reaches settle(), so the turn table
// gains no row for it — while the spec (agent-fleet-core「回合结果事件」) counts
// interrupted among the four statuses and among "real turns" for presence.
// The sweep runs once per boot, AFTER the engine has loaded and the fleet
// recorder is attached: every record carrying `interruptedAt` (stamped at the
// load-time rewrite) and not yet marked gets exactly one `status=interrupted`
// event through the SAME seam live turns use, then is marked and persisted.
//
// Injectable seams (recordEvent / markRecorded / now / hasEvent) exist for the
// test: the recorder and the engine are module-level, and a test must be able
// to drive both halves (exactly one row; idempotent on a second pass) without
// booting a server. A record-event failure leaves the marker unset — the next
// restart retries — and never throws into boot.
//
// Legacy records (2026-11-15 生产实证): records interrupted BEFORE this fix
// shipped were persisted as state=interrupted without `interruptedAt` (the
// rewrite only fires for records still running at load), so gating on the
// stamp leaves exactly the backlog we shipped this to make visible invisible.
// For those: stamp detection now (first boot that can see the record), date
// the event from the round's own `lastRun` so the daily bucket (keyed on
// started_at) lands on the day that was actually lost, and end it AT START —
// the zero-length convention the slot-claim path already writes for
// interrupted rounds. `hasEvent` guards the other direction: the slot-claim
// path (worker-slots) may already have written an interrupted row for the
// same round (±tolerance); skip those rather than double-record (spec:
// 不重复记账).
function sweepInterruptedTurnEvents({ recordEvent, markRecorded, hasEvent, now = Date.now() } = {}) {
  if (typeof recordEvent !== "function" || typeof markRecorded !== "function") {
    throw new Error("sweepInterruptedTurnEvents requires recordEvent and markRecorded");
  }
  let recorded = 0;
  let failed = 0;
  let legacy = 0;
  let skippedExisting = 0;
  for (const t of engine.allRecords()) {
    if (t?.state !== "interrupted") continue;
    if (t.interruptionRecordedAt != null) continue; // already recorded (idempotent)
    const isLegacy = !Number.isFinite(t.interruptedAt);
    if (isLegacy) t.interruptedAt = now; // detection = first boot that can see it
    const startedAt = Number.isFinite(Date.parse(t.lastRun))
      ? Date.parse(t.lastRun)
      : (isLegacy ? now : t.interruptedAt);
    if (typeof hasEvent === "function" && hasEvent(t, startedAt)) {
      if (markRecorded(t.id, now)) skippedExisting += 1;
      continue; // same round already has its interrupted row — do not double-record
    }
    try {
      recordEvent(t, { ok: false, interrupted: true, error: t.error ?? "cell restarted during execution" }, {
        startedAt,
        endedAt: isLegacy ? startedAt : now, // legacy: unknown end, zero-length convention
        model: null,
        ledgerTurn: null,
      });
    } catch (e) {
      failed += 1;
      console.warn(`[cron] interrupted turn event failed for ${t.id}: ${e?.message || e}`);
      continue; // no marker — the next restart retries this record
    }
    if (markRecorded(t.id, now)) {
      recorded += 1;
      if (isLegacy) legacy += 1;
    }
  }
  return { recorded, failed, legacy, skippedExisting };
}

// Persist the markers the sweep just set (batched: one write for the whole
// pass, not one per record). Fire-and-forget on the caller side.
function persistInterruptionMarkers() {
  return engine.saveTasks();
}

// ── Graceful Shutdown ────────────────────────────────────────────────────────

function shutdown() {
  for (const task of engine.allRecords()) {
    if (task.job) {
      task.job.cancel();
    }
  }
  schedule.gracefulShutdown();
}

export {
  initCron,
  addJob,
  updateJob,
  removeJob,
  pauseJob,
  resumeJob,
  listJobs,
  getJob,
  isEngineInitialized,
  fireTask,
  setFleetContextRenderer,
  hasFleetContextRenderer,
  keepFleetContextPlaceholder,
  runJobNow,
  // Retry ladder hand-off (2026-11-08): the runner's readiness gate re-enqueues
  // the same round instead of losing it. Returns false when the record is gone.
  reenqueueJob,
  // 停机缺口计数（含水位纪律）：导出给测试钉"同一缺口只记一次"。
  countMissedOccurrences,
  getDashboardState,
  validateCron,
  // Downtime catch-up decision (P2, 2026-10-26) — exported so the window and
  // the kill switch are pinned by a test rather than only exercised at boot.
  withinToleranceWindow,
  makeUpInterruptedBeat,
  drainPendingMakeups,
  sweepInterruptedTurnEvents,
  persistInterruptionMarkers,
  shutdown,
};
