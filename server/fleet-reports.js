// Fleet report lane core (agent-fleet-report-lane).
//
// Pure/injectable logic for the status-report tool: payload validation (lenient
// write, strict presentation — undeclared slot keys are kept in the report but
// never reach the card), server-side attribution (preset → post, running
// cluster task → post; the caller can never name a post), flood control
// (window = half the cadence period, 10-minute floor, 3 per window), and the
// read-side views (latest with system-computed trends, timeline pages).
// Storage lives in fleets-db; the HTTP/tool faces live in routes/fleets.js
// and server/fleet-mcp.js.

import { resolveModelChain, resolveAgentEffort, pickBudgetFallback } from "./fleet-model.js";
import { isPersonaBackedTargetKind } from "./routes/fleets-db.js";

const SUMMARY_MAX = 4000;
const METRIC_VALUE_MAX = 300;
const RESOURCES_MAX = 50;
const BLOCKERS_MAX = 20;
const REPORT_BODY_LIMIT = 8 * 1024; // design D7: one report ≤ 8KB
const FLOOD_WINDOW_FLOOR_MS = 10 * 60 * 1000;
const FLOOD_MAX_PER_WINDOW = 3;

// ── Validation (lenient write, strict presentation) ─────────────────────────

// Returns { ok, report } | { ok: false, error }. `metrics` keeps every
// submitted key verbatim (details must not lose data); slot filtering happens
// only in the card view. Anything structurally unusable is rejected.
export function validateReportPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "report payload must be an object" };
  }
  const { metrics, resources, blockers, summary } = payload;
  if (!summary || typeof summary !== "string" || !summary.trim()) {
    return { ok: false, error: "summary is required" };
  }
  if (summary.length > SUMMARY_MAX) {
    return { ok: false, error: `summary exceeds ${SUMMARY_MAX} characters` };
  }

  const cleanMetrics = {};
  if (metrics !== undefined && metrics !== null) {
    if (typeof metrics !== "object" || Array.isArray(metrics)) {
      return { ok: false, error: "metrics must be an object keyed by slot key" };
    }
    for (const [key, slot] of Object.entries(metrics)) {
      if (typeof key !== "string" || !key.trim()) {
        return { ok: false, error: "metric keys must be non-empty strings" };
      }
      if (!slot || typeof slot !== "object") {
        return { ok: false, error: `metric '${key}' must be { value, delta? }` };
      }
      const value = slot.value;
      if (typeof value !== "string" && typeof value !== "number") {
        return { ok: false, error: `metric '${key}'.value must be a string or number` };
      }
      if (String(value).length > METRIC_VALUE_MAX) {
        return { ok: false, error: `metric '${key}'.value exceeds ${METRIC_VALUE_MAX} characters` };
      }
      cleanMetrics[key] = {
        value,
        ...(slot.delta !== undefined && slot.delta !== null ? { delta: String(slot.delta).slice(0, 300) } : {}),
      };
    }
  }

  let cleanResources = [];
  if (resources !== undefined && resources !== null) {
    if (!Array.isArray(resources) || resources.length > RESOURCES_MAX) {
      return { ok: false, error: `resources must be an array of at most ${RESOURCES_MAX} entries` };
    }
    cleanResources = resources.map((r) => ({
      name: String(r?.name ?? "").slice(0, 200),
      kind: String(r?.kind ?? "").slice(0, 60),
      ...(r?.url ? { url: String(r.url).slice(0, 500) } : {}),
    }));
  }

  let cleanBlockers = [];
  if (blockers !== undefined && blockers !== null) {
    if (!Array.isArray(blockers) || blockers.length > BLOCKERS_MAX) {
      return { ok: false, error: `blockers must be an array of at most ${BLOCKERS_MAX} strings` };
    }
    cleanBlockers = blockers.map((b) => String(b).slice(0, 500));
  }

  const report = { metrics: cleanMetrics, resources: cleanResources, blockers: cleanBlockers, summary };
  if (JSON.stringify(report).length > REPORT_BODY_LIMIT) {
    return { ok: false, error: "report exceeds the 8KB size limit" };
  }
  return { ok: true, report };
}

// ── Attribution ──────────────────────────────────────────────────────────────

// Resolve which post a report belongs to, from the server's own execution
// context — never from caller input (design D3):
//   1. An in-flight fleet turn (the run ledger's open turns): it names the post
//      it executes, whatever the target kind. This is the signal that survives
//      persona parking — a parked round mounts its persona on the SESSION and
//      deliberately leaves the runtime's deployment default alone, so neither
//      the live preset nor a "cluster-only" running-task scan can name it
//      (fix-parked-preset-attribution: the 06:11Z rollout zeroed self reports
//      fleet-wide because attribution read the deployment default).
//   2. A fleet task currently running whose `sourceTag` names its post
//      (cron-materialized fleet rounds). The wire shape carries sourceTag but
//      NOT `origin` (internal), so dispatch/handoff/manual shapes rely on the
//      ledger branch above; this one covers rounds whose ledger entry is
//      unavailable (ledger degrade-open) and cluster fan-outs that rotate
//      member presets.
//   3. Otherwise the live preset: persona posts whose roster preset id (or raw
//      target id) equals it. Exactly one → that post; several → ambiguous
//      rejection (overlapping user-built fleets must not be guessed); none →
//      the caller is not a fleet member.
//
// 自报身份的归一与校验（fix-report-attribution-concurrency 2.3）。三关全过才采纳：
// ① 该 pair 真实存在（在 persona 岗位集合里，已排掉归档舰队）② 岗位的 fleetId 与自报一致
// ③ 岗位的 persona 与自报的 persona 归一后一致。任一不过 ⇒ null（当作没自报，
// 继续走其余优先级）。这条把"服务端自己写进 patch 的坐标"变成可用信号，
// 同时不给"调用方随便指个 memberId 就认"开后门。
export function normalizeSelfIdentity(selfIdentity, personaMembers = [], rosterPresetId = (id) => id) {
  const fleetId = selfIdentity?.fleetId;
  const memberId = selfIdentity?.memberId;
  const persona = selfIdentity?.persona;
  if (!fleetId || !memberId || !persona) return null;
  const member = (Array.isArray(personaMembers) ? personaMembers : []).find((m) => m?.id === memberId);
  if (!member) return null;
  if (String(member.fleetId ?? "") !== String(fleetId)) return null;
  if (member.paused === true) return null;
  if (rosterPresetId(member.targetId) !== rosterPresetId(persona)) return null;
  return { fleetId: member.fleetId, memberId: member.id, member };
}

// Every branch reads SERVER state; none reads the caller's payload.
export function resolveAttribution({ currentPreset, runningTasks = [], openTurns = [], personaMembers = [], rosterPresetId = (id) => id, selfIdentity = null }) {
  const openFleetTurns = (Array.isArray(openTurns) ? openTurns : []).filter((t) => t?.fleetId && t?.memberId);
  // 自报身份优先（fix-report-attribution-concurrency 2.x）：它是唯一在并发下仍然
  // 指向"这一轮到底是谁"的信号——因为坐标由服务端写进该 worker 的私有 patch，
  // 而不是从任何全局值推出来的。
  const self = normalizeSelfIdentity(selfIdentity, personaMembers, rosterPresetId);
  if (self) return { kind: "self-report", fleetId: self.fleetId, memberId: self.memberId, member: self.member };
  if (openFleetTurns.length === 1) {
    const turn = openFleetTurns[0];
    return { kind: "turn", fleetId: turn.fleetId, memberId: turn.memberId, turn };
  }
  // Several turns in flight (a chain crossing posts, or overlapping fleets):
  // no single post owns this call. Fall through — the preset branch may still
  // resolve a chat-lane caller, and an unresolvable one is rejected honestly
  // rather than guessed (design D1: uniqueness or nothing).

  const runningFleetTasks = runningTasks.filter((t) => t?.state === "running" && t?.sourceTag?.fleetId);
  if (runningFleetTasks.length === 1) {
    const task = runningFleetTasks[0];
    const kind = task.targetType === "cluster" ? "cluster-task" : "job-sourceTag";
    return { kind, fleetId: task.sourceTag.fleetId, memberId: task.sourceTag.memberId ?? null, task };
  }

  // 并发下的收紧（fix-report-attribution-concurrency 1.1）。走到这里且并发数 ≥2，
  // 说明上面两级**都**失配了：既没有唯一的在飞回合，也没有唯一带 sourceTag 的运行中任务。
  // 这时下面唯一还能用的信号是 `currentPreset`——而它是**整个 cell 的一个全局值**
  // （最后一次 set_preset / 最后跑的那个预设），不是"本回合自身的目标 preset"。
  // 拿它兜底就是在猜：猜中的那一半看起来正常，猜错的那一半把报数记到别人的岗位上。
  // 生产 2026-11-12 实测：双 worker 上线后两个舰队的岗同时跑，漂移哨与主编的报数
  // 双双落到「书记」头上、槽位全判 UNRECOGNIZED；而本函数原有的用例只覆盖了
  // "全局 preset 恰好不匹配任何岗"那半边（那种情况下是诚实的 none），所以这个洞一直绿着。
  // 规格（agent-fleet-report-lane）本就要求：不能唯一命中时诚实拒收，SHALL NOT 猜测。
  if (openFleetTurns.length > 1 || runningFleetTasks.length > 1) {
    const candidates = [
      ...openFleetTurns.map((t) => `${t.fleetId}:${t.memberId}`),
      ...runningFleetTasks.map((t) => `${t.sourceTag.fleetId}:${t.sourceTag.memberId ?? "?"}`),
    ];
    return {
      kind: "ambiguous",
      error:
        `several rounds are in flight (${candidates.join(", ")}) — the runtime's live preset ` +
        `cannot tell which post is reporting (a cell-wide value is not this round's own preset)`,
    };
  }

  if (!currentPreset) {
    return { kind: "none", error: "no agent is running — cannot attribute a report" };
  }
  const hits = personaMembers.filter(
    (m) =>
      isPersonaBackedTargetKind(m.targetKind) &&
      (m.targetId === currentPreset || rosterPresetId(m.targetId) === currentPreset),
  );
  if (hits.length === 1) {
    return { kind: "preset", fleetId: hits[0].fleetId, memberId: hits[0].id, member: hits[0] };
  }
  if (hits.length > 1) {
    return {
      kind: "ambiguous",
      error: `this agent holds several posts (${hits.map((m) => m.title).join(", ")}) — reports would be ambiguous`,
    };
  }
  return { kind: "none", error: "this agent is not a member of any fleet — report_status is for fleet posts" };
}

// ── Turn identity ────────────────────────────────────────────────────────────

// The one-line post identity a fleet member's turn carries at the head of its
// prompt (enable-wire-content-fleet D1), so an agent can NAME its own
// production source instead of inventing a string. `turn` (add-fleet-identity-turn)
// completes the deploy/post/round triple external consumers recite as
// source_ref — the caller hands in the round's landed child session id; absent
// turn keeps the line byte-identical (non-turn callers never grow a segment).
// Attribution decides who (resolveAttribution above); this only formats.
// Credential-free by construction — ids and a title, nothing else — and never
// written to the catalog or an AgentCard.
export function renderFleetIdentity({ fleetId, memberId, title, targetKind, targetId, turn }) {
  const base = `【集群岗位身份】fleet=${fleetId}; post=${memberId}; title=${title ?? ""}; target=${targetKind ?? ""}:${targetId ?? ""}`;
  return turn ? `${base}; turn=${turn}` : base;
}

// The post a persona is on duty for → its turn identity line, or null.
// Attribution is the report bridge's own (resolveAttribution): no post or
// several posts (ambiguous) both yield null, so the turn runs unchanged.
// `turn` rides through to renderFleetIdentity verbatim.
export function fleetIdentityFor(db, presetId, { rosterPresetId = (id) => id, turn = null } = {}) {
  if (!presetId) return null;
  const personaMembers = [];
  for (const f of db.listFleets()) {
    // Ghost-post guard (0030e1e8 family): a dissolved fleet's posts exit
    // attribution — the same guard the report/escalate scans carry. Without
    // it a ghost post makes the live post's attribution ambiguous (null):
    // identity prefix lost, post-model normalization silently skipped.
    if (f.state === "archived") continue;
    for (const m of db.listMembers(f.id)) {
      if (isPersonaBackedTargetKind(m.targetKind)) personaMembers.push(m);
    }
  }
  const attribution = resolveAttribution({ currentPreset: presetId, personaMembers, rosterPresetId });
  if (attribution.kind !== "preset") return null;
  const member = db.getMember(attribution.memberId);
  if (!member) return null;
  return renderFleetIdentity({
    fleetId: member.fleetId,
    memberId: member.id,
    title: member.title,
    targetKind: member.targetKind,
    targetId: member.targetId,
    turn,
  });
}

// The post a persona is on duty for → its resolved model plan, or null
// (add-fleet-post-model D3). Same attribution seam as fleetIdentityFor: the
// turn path hands in its live preset, this finds the on-duty member and
// resolves the chain [member.model, member.fallbackModel, fleet.defaultModel,
// cellDefault] against the current roster. Lookup is per-turn by design — the
// model declaration is NEVER materialized into the task record, so a PATCH
// costs zero reconciliation.
export function fleetModelFor(db, presetId, { rosterPresetId = (id) => id, roster = null, cellDefault = null, budgetProbe = null } = {}) {
  if (!presetId) return null;
  const personaMembers = [];
  for (const f of db.listFleets()) {
    // Ghost-post guard (0030e1e8 family): a dissolved fleet's posts exit
    // attribution — the same guard the report/escalate scans carry. Without
    // it a ghost post makes the live post's attribution ambiguous (null):
    // identity prefix lost, post-model normalization silently skipped.
    if (f.state === "archived") continue;
    for (const m of db.listMembers(f.id)) {
      if (isPersonaBackedTargetKind(m.targetKind)) personaMembers.push(m);
    }
  }
  const attribution = resolveAttribution({ currentPreset: presetId, personaMembers, rosterPresetId });
  if (attribution.kind !== "preset") return null;
  const member = db.getMember(attribution.memberId);
  if (!member) return null;
  const fleet = db.getFleet(member.fleetId);
  const fleetDefault = fleet?.defaultModel ?? null;
  const plan = resolveModelChain({
    model: member.model,
    fallbackModel: member.fallbackModel,
    fleetDefault,
    cellDefault,
    roster,
  });
  // Config dimensions (add-agent-config-dims): the SAME post the model chain
  // resolved, so effort/budget can never point at a different post than the
  // model does. Judged against the effective model — a level the landed model
  // does not declare falls through with a notice.
  const effort = resolveAgentEffort({
    agentEffort: member.effort ?? null,
    fleetEffort: fleet?.effort ?? null,
    model: plan.effective,
    roster,
  });
  // 预算门注记（add-model-surface-budget-gate 2.3）：链上每一跳问一次
  // budgetProbe（daily/monthly 是否已超限），超限跳在 plan 上打
  // budgetBlocked——normalizeModelForJob 的 walk 据此跳过该跳（自然走降级
  // 链下一跳），报表面也看得见。probe 缺席/引擎关=零注记（degrade-open，
  // 字节不差旧行为）。probe 抛错=该跳放行（预算门故障不拦合法模型）。
  let budgetBlocked = null;
  if (typeof budgetProbe === "function") {
    try {
      budgetBlocked = [];
      for (const hop of plan.candidates) {
        const verdict = budgetProbe(hop.model);
        if (verdict && verdict.allowed === false) budgetBlocked.push({ model: hop.model, blocked: verdict.blocked ?? [] });
      }
      if (!budgetBlocked.length) budgetBlocked = null;
      // Every declared hop over budget ⇒ append a model that still HAS room
      // instead of failing the round (2026-11-10 live: the optimizer post died
      // `budget_exhausted` on every fire while `deepseek-flash` sat at zero
      // usage on the same runner). The declared chain is a preference order,
      // not a whitelist — running somewhere beats not running at all.
      if (budgetBlocked && plan.candidates.length > 0 && budgetBlocked.length === plan.candidates.length) {
        const rescue = pickBudgetFallback({
          candidates: plan.candidates,
          blocked: budgetBlocked,
          roster,
          probe: budgetProbe,
        });
        if (rescue) {
          // Push at the END: a declared hop that later regains budget still
          // wins, so this never reorders preferences — it only adds a floor.
          plan.candidates = [...plan.candidates, { model: rescue, source: "budget-fallback" }];
          if (!plan.effective) plan.effective = rescue;
          plan.notices = [
            ...(plan.notices ?? []),
            `every declared model is over budget — falling back to '${rescue}' (has room)`,
          ];
        }
      }
    } catch {
      budgetBlocked = null;
    }
  }
  return {
    memberId: member.id,
    fleetDefault,
    ...plan,
    // fix-fleet-model-drift: a declared chain on the post flags whether the
    // turn MUST re-assert its model each round (no session-ledger early
    // return — that ledger can drift away from the child's own selection).
    explicitChain: Boolean(member.model || member.fallbackModel),
    effort: effort.effort,
    effortSource: effort.source,
    effortNotices: effort.notices,
    contextBudget: member.contextBudget ?? fleet?.contextBudget ?? null,
    budgetBlocked,
  };
}

// ── Flood control ────────────────────────────────────────────────────────────

export function floodWindowMs(cadence, cronPeriodMs) {
  if (!cadence) return FLOOD_WINDOW_FLOOR_MS;
  const period = cronPeriodMs(cadence.cron, cadence.tz);
  if (!period) return FLOOD_WINDOW_FLOOR_MS;
  return Math.max(Math.floor(period / 2), FLOOD_WINDOW_FLOOR_MS);
}

// Returns { ok: true } | { ok: false, error, windowResetsAt }.
//
// `roundReports` is how many reports THIS round (same session) already filed.
// A round that has not reported yet is never throttled: flood control exists to
// stop one post from spamming its card, not to forbid a round from reporting.
// Live 2026-11-09: a stray `summary:"probe"` report from a platform session
// filled the 3-per-720min window, and the proposal post's one honest report —
// carrying the rejected-slot disclosure — was rejected whole. The ledger kept
// an empty `metrics:{}` row and the real report vanished, which read like "the
// model never reported". First-report-of-round is the fix at that boundary.
export function checkFlood({
  countSince,
  roundReports = null,
  windowMs,
  now = Date.now(),
  oldestInWindowAt = null,
}) {
  // `null` = the caller did not tell us (legacy callers): keep the old
  // behaviour rather than granting an exemption on a guess.
  if (roundReports === 0) return { ok: true };
  if (countSince < FLOOD_MAX_PER_WINDOW) return { ok: true };
  const windowResetsAt = oldestInWindowAt != null ? oldestInWindowAt + windowMs : now + windowMs;
  return {
    ok: false,
    error: `report limit reached (${FLOOD_MAX_PER_WINDOW} per ${Math.round(windowMs / 60000)} minutes) — next window at ${new Date(windowResetsAt).toISOString()}`,
    windowResetsAt,
  };
}

// ── Trends (system-computed; agent deltas are notes, never arithmetic) ───────

// Compare a slot's current value with the previous report's same-slot value.
// Numeric pairs get direction + numeric delta; string pairs get a changed/
// unchanged direction with no fabricated delta; no predecessor → null (无趋势,
// never faked).
export function computeTrend(currentValue, previousValue) {
  if (previousValue === undefined || previousValue === null) return null;
  const cur = currentValue?.value;
  const prev = typeof previousValue === "object" ? previousValue.value : previousValue;
  if (prev === undefined || prev === null) return null;
  const curNum = typeof cur === "number" ? cur : typeof cur === "string" && cur.trim() !== "" && Number.isFinite(Number(cur)) ? Number(cur) : null;
  const prevNum = typeof prev === "number" ? prev : typeof prev === "string" && prev.trim() !== "" && Number.isFinite(Number(prev)) ? Number(prev) : null;
  if (curNum != null && prevNum != null) {
    const delta = curNum - prevNum;
    return { direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat", deltaValue: delta };
  }
  return { direction: String(cur) === String(prev) ? "flat" : "changed", deltaValue: null };
}

// ── a2a derived execution summaries ─────────────────────────────────────────

// A finished a2a fleet task cannot self-report (the remote agent cannot call
// this cell's tools — physical fact, design D4): its last outcome becomes a
// derived report row, honestly badged. Returns null for anything that is not
// a finished a2a fleet fire.
export function derivedReportFromTask(task, { now = Date.now() } = {}) {
  if (!task?.sourceTag?.fleetId || task.targetType !== "a2a") return null;
  const last = Array.isArray(task.history) ? task.history[task.history.length - 1] : null;
  if (!last || last.time == null) return null;
  const ok = last.success !== false;
  const text = typeof last.text === "string" && last.text.trim() ? last.text.trim() : "";
  const summary = ok
    ? text.slice(0, SUMMARY_MAX) || "回合完成（无文本产出）"
    : `执行失败：${last.error || "未知错误"}`.slice(0, SUMMARY_MAX);
  return {
    id: `r_${now}_${Math.random().toString(36).slice(2, 8)}`,
    fleetId: task.sourceTag.fleetId,
    memberId: task.sourceTag.memberId,
    sessionId: task.sessionId ?? null,
    metrics: {},
    resources: [],
    blockers: ok ? [] : [String(last.error || "回合失败").slice(0, 500)],
    summary,
    source: "derived",
    createdAt: Date.parse(last.time) || now,
  };
}

// ── Read-side views ──────────────────────────────────────────────────────────

// The card-facing latest view: declared slots only (slot key → presentation),
// each carrying the system trend vs the previous report; the full metric set
// stays on the report row for the detail drawer.
export function buildLatestView({ report, previous, kpiSlots }) {
  if (!report) return null;
  const declared = new Map(kpiSlots.map((s) => [s.key, s]));
  const slots = kpiSlots
    .filter((s) => report.metrics[s.key] !== undefined)
    .map((s) => {
      const m = report.metrics[s.key];
      return {
        key: s.key,
        label: s.label,
        unit: s.unit ?? null,
        value: m.value,
        // The agent's self-reported delta is presentation-only annotation.
        note: m.delta ?? null,
        trend: computeTrend(m, previous?.metrics?.[s.key]),
      };
    });
  return {
    id: report.id,
    at: report.createdAt,
    summary: report.summary,
    source: report.source, // self | derived (a2a 执行摘要)
    sessionId: report.sessionId ?? null,
    slots,
    undeclaredKeys: Object.keys(report.metrics).filter((k) => !declared.has(k)),
    metricsAll: report.metrics,
    blockers: report.blockers,
  };
}

// The timeline row (the drawer's first page and the team console's `stream`
// block): one report reduced to what a reader scans. Shared so the owner
// cockpit and the console report list can never disagree about a row's shape.
export function reportTimelineEntry(report) {
  return {
    id: report.id,
    at: report.createdAt,
    summary: report.summary,
    metrics: report.metrics,
    blockers: report.blockers,
    resources: report.resources,
    source: report.source,
    sessionId: report.sessionId ?? null,
  };
}
