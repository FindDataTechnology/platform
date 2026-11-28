// fleet-ops-manager — the repair brain of the AI operations manager
// (openspec: fleet-ops-manager).
//
// The diagnosis capability (fleet-failure-diagnosis) already turns a failed turn
// into "conclusion + evidence + ONE action" — but the action is a pointer, not a
// landed repair. This module closes the loop: it takes that diagnosis and turns
// it into a STRUCTURAL repair expressed as a diff of the one TeamStructure
// (lib/team-structure.js), whitelisted per error_kind so a repair can only touch
// what the diagnosis justifies.
//
// Pure by design: diagnosis + live rows + model roster in, a repair diff out.
// It reads no DB and writes nothing — the caller routes the diff through the
// EXISTING fleet_draft → approval → fleet_apply lane. This module is only the
// decision: "what structural change does this failure justify, or do we lack the
// evidence to propose anything at all".
//
// The whitelist is the whole point: a repair that touches a key outside its
// error_kind's allowed set is not "derived from diagnosis" and is refused — the
// same discipline as criterion-must-fire-on-real-data ("a repair not traceable
// to the facts is more dangerous than no repair").

import { membersFromLive, diffTeamStructure, applyTeamDiff } from "./team-structure.js";

// Allowed structural keys per error_kind. A repair may only change these.
export const REPAIR_WHITELIST = Object.freeze({
  budget: Object.freeze(["model", "fallbackModel", "effort"]),
  timeout: Object.freeze(["model", "cadence"]), // cadence: only turnTimeoutMs (checked deep)
  model_upstream: Object.freeze(["model", "fallbackModel"]),
});

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const HEALTHY_BUDGET_PCT = 20; // a candidate with >20% remaining counts as healthy
// 诊断说不出「当前预算」时（裸 "turn timed out"）用的保守抬高值。15 分钟——
// 低于任何已知的生产单轮上限（软停实测 960s/1200s），所以不会把上限改小。
const DEFAULT_RAISED_TURN_TIMEOUT_MS = 15 * 60_000;

// Pick a healthy candidate model distinct from the current one. Evidence-driven:
// only models the roster marks with remaining budget qualify. null = none.
function pickHealthyModel(currentModel, roster) {
  const candidates = (Array.isArray(roster) ? roster : []).filter(
    (m) => isObj(m) && typeof m.id === "string" && m.id && m.id !== currentModel,
  );
  const healthy = candidates.filter((m) => Number(m.budgetRemainingPct) > HEALTHY_BUDGET_PCT);
  // Prefer the healthiest; stable tie-break by id so the derivation is deterministic.
  healthy.sort((a, b) => Number(b.budgetRemainingPct) - Number(a.budgetRemainingPct) || a.id.localeCompare(b.id));
  return healthy.length ? healthy[0].id : null;
}

// Apply ONE diagnosis to a target member (mutating the desired copy). Returns
// { missing } when the evidence needed to act is absent — never guesses.
function applyRepair(diag, target, roster) {
  const kind = diag?.errorKind;
  if (kind === "budget") {
    if (target.fallbackModel) return {}; // already has a fallback — nothing to repair
    const pick = pickHealthyModel(target.model, roster);
    if (!pick) return { missing: "no healthy candidate model with remaining budget" };
    target.fallbackModel = pick;
    return {};
  }
  if (kind === "model_upstream") {
    if (target.fallbackModel) return {};
    const pick = pickHealthyModel(target.model, roster);
    if (!pick) return { missing: "no alternate available model for upstream failover" };
    target.fallbackModel = pick;
    return {};
  }
  if (kind === "timeout") {
    const bump = diag?.evidence?.turnTimeoutMs;
    // 生产实测（2026-11-28，cell 1da519d4c1c0bf89）：1168 条 timeout 的错误文本
    // 几乎都是裸的「turn timed out」，不含任何预算数字，于是诊断给不出
    // turnTimeoutMs —— 诊断侧自己的 action 却写着「调高回合超时上限」。两侧契约
    // 不一致，错在这一侧：调高超时**不需要知道当前值**。
    // 已知当前值 ⇒ 翻倍；不知道 ⇒ 保守绝对下限。都没有时才算证据不足。
    const base = isObj(target.cadence) ? target.cadence : {};
    const current = Number(base.turnTimeoutMs);
    const next =
      Number.isFinite(bump) && bump > 0
        ? bump
        : Number.isFinite(current) && current > 0
          ? current * 2
          : DEFAULT_RAISED_TURN_TIMEOUT_MS;
    // 无 cadence 的岗也要能加预算（2026-11-27 实测）：`turnTimeoutMs` 是
    // resolveTurnBudgetMs 的唯一来源，与 cron 是否存在无关——一个被手动/委派
    // 触发的岗没有 cron，照样会撞软停。空 cadence 只补 turnTimeoutMs，绝不凭空造 cron。
    target.cadence = { ...base, turnTimeoutMs: next };
    return {};
  }
  return { missing: `no repair mapping for error_kind '${kind}'` };
}

// The top-level member keys that differ between before and after.
function changedTopKeys(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out = [];
  for (const k of keys) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out.push(k);
  }
  return out;
}

// A cadence change is only whitelisted for `timeout` if NOTHING but turnTimeoutMs
// moved inside it (otherwise a repair could smuggle a cron change through the
// cadence key).
function cadenceOnlyTimeoutChanged(before, after) {
  const a = isObj(before) ? before : {};
  const b = isObj(after) ? after : {};
  const stripped = (c) => {
    const { turnTimeoutMs, ...rest } = c;
    return JSON.stringify(rest);
  };
  return stripped(a) === stripped(b);
}

// The whitelist guard, extracted so a test can drive a deliberate out-of-whitelist
// change and prove it fires (a guard that is never exercised is a guard you don't
// know works). Returns [] when every changed key is justified by the diagnosed
// error_kind(s) for that post.
export function whitelistViolations(diagnoses, beforeMembers, afterMembers) {
  const diags = Array.isArray(diagnoses) ? diagnoses.filter((d) => isObj(d) && typeof d.ref === "string") : [];
  const kindsByRef = new Map();
  for (const d of diags) {
    if (!kindsByRef.has(d.ref)) kindsByRef.set(d.ref, new Set());
    kindsByRef.get(d.ref).add(d.errorKind);
  }
  const beforeBy = new Map((Array.isArray(beforeMembers) ? beforeMembers : []).map((m) => [m.ref, m]));
  const after = Array.isArray(afterMembers) ? afterMembers : [];
  const violations = [];
  for (const a of after) {
    const b = beforeBy.get(a.ref);
    if (!b) continue; // an add is out of scope for the repair whitelist (repairs don't add posts)
    const kinds = kindsByRef.get(a.ref) ?? new Set();
    const allowed = new Set();
    for (const k of kinds) for (const key of REPAIR_WHITELIST[k] ?? []) allowed.add(key);
    for (const key of changedTopKeys(b, a)) {
      if (!allowed.has(key)) {
        violations.push({ ref: a.ref, key, errorKinds: [...kinds] });
        continue;
      }
      // cadence is only a legal change for `timeout`, and only via turnTimeoutMs.
      if (key === "cadence" && !(kinds.has("timeout") && cadenceOnlyTimeoutChanged(b.cadence, a.cadence))) {
        violations.push({ ref: a.ref, key: "cadence", reason: "cadence change not limited to turnTimeoutMs under timeout" });
      }
    }
  }
  return violations;
}

// ── repairDraft: diagnosis → structural repair diff (the manager's decision) ──
//
// Inputs:
//   diagnoses:  [{ ref, errorKind, evidence?: { turnTimeoutMs? } }]
//   liveRows:   live member rows (id/title/parent_id/target_kind/… shape)
//   modelRoster:[{ id, budgetRemainingPct }]
//
// Returns one of:
//   { ok:true, noRepairNeeded:true, diff }                       — diagnosed, nothing to fix
//   { ok:true, diff, desired }                                   — a repair to route through fleet_draft
//   { ok:false, reason, missingEvidence:[{ref,errorKind,reason}] } — insufficient evidence (NOT a repair)
export function repairDraft({ diagnoses = [], liveRows = [], modelRoster = [] } = {}) {
  const diags = Array.isArray(diagnoses) ? diagnoses.filter((d) => isObj(d) && typeof d.ref === "string") : [];
  const live = membersFromLive(liveRows);
  // Work on copies so the live structure is never mutated.
  const desired = live.map((m) => ({ ...m, cadence: m.cadence ? { ...m.cadence } : m.cadence }));
  const desByRef = new Map(desired.map((m) => [m.ref, m]));

  const skipped = [];
  for (const d of diags) {
    const target = desByRef.get(d.ref);
    if (!target) {
      skipped.push({ ref: d.ref, errorKind: d.errorKind, reason: "post not found in live structure" });
      continue;
    }
    const res = applyRepair(d, target, modelRoster);
    if (res.missing) skipped.push({ ref: d.ref, errorKind: d.errorKind, reason: res.missing });
  }
  // Evidence beats guessing, PER POST — not per batch.
  //
  // 2026-11-28 真数据（cell 1da519d4c1c0bf89，206 岗）：98 条诊断里只有 1 条指向
  // 已不存在的岗（换防/删岗留下的历史回合）。原来的「任一缺证据 ⇒ 整批不提案」
  // 让那 1 条把另外 97 条可作的修复全毙掉 —— 在一个常年换防的部署里，等于永不
  // 出手。现在可作的照作，作不了的逐条记进 skipped（不猜、但也不连坐）。
  // 全部作不了时仍然是 ok:false —— 那才是真的「无可提案」。
  if (skipped.length && skipped.length === diags.length) {
    return { ok: false, reason: "insufficient evidence for every diagnosis", missingEvidence: skipped };
  }

  const diff = diffTeamStructure(live, desired);

  // Whitelist guard: every changed top-level key on every update must be allowed
  // by the error_kind(s) diagnosed FOR THAT POST. This is what makes "the repair
  // came from the diagnosis" a machine-checkable fact, not a promise.
  const violations = whitelistViolations(diags, live, desired);
  if (violations.length) {
    return { ok: false, reason: "repair changes keys outside the diagnosis whitelist", violations };
  }

  const result = diff.adds.length === 0 && diff.updates.length === 0 && diff.removes.length === 0
    ? { ok: true, noRepairNeeded: true, diff }
    : { ok: true, diff, desired };
  // 逐条如实回执：作了哪些、跳过了哪些及原因。调用方据此显示「N 条建议 / M 条无法处理」，
  // 而不是把跳过悄悄吞掉。
  if (skipped.length) result.skipped = skipped;
  return result;
}

// ── verifyOutcome: after landing, read the same error_kind's counts again ─────
//
// Returns one of { state: "improved" | "unchanged" | "insufficient-evidence",
// before, after, kind }. Three states, never merged — and never "fixed" without
// evidence of improvement (spec: 落地后复验三态如实回报).
export const MIN_VERIFY_SAMPLE = 3; // fewer failing turns than this can't settle a verdict

export function verifyOutcome({ kind, beforeCount, afterCount } = {}) {
  const before = Number(beforeCount);
  const after = Number(afterCount);
  const base = { kind: kind ?? null, before: Number.isFinite(before) ? before : null, after: Number.isFinite(after) ? after : null };
  if (!Number.isFinite(before) || !Number.isFinite(after)) {
    return { state: "insufficient-evidence", ...base, reason: "missing before/after counts" };
  }
  // The window's own size gates the verdict: a count of 0→0 is not "improved".
  if (before < MIN_VERIFY_SAMPLE) {
    return { state: "insufficient-evidence", ...base, reason: `fewer than ${MIN_VERIFY_SAMPLE} failing turns in the prior window` };
  }
  if (after < before) return { state: "improved", ...base };
  return { state: "unchanged", ...base };
}

// Re-export the diff applier so the caller can materialize desired from the diff
// with one import (and so a test can prove apply(diff) === desired).
export { applyTeamDiff };

// ── renderRepairOps: the repair diff → the EXISTING architect ops shape ───────
//
// The architect lane (agent-fleet-architect) already validates and applies a
// `{mode, fleetId, members:[{op,...}]}` draft, with its own revalidate + drift
// deny. Rather than invent a second write face, the manager renders its repair
// diff into exactly that shape and sends it through fleet_draft. A repair only
// ever UPDATES existing posts (it never adds/removes them), so `adds`/`removes`
// in a repair diff are a bug — surfaced, not silently rendered.
//
// Each update op carries only the changed keys (so we never re-send unchanged
// fields the architect would then have to re-derive). `cadence` is passed whole;
// the architect reads {cron,tz,promptTemplate} from it.
export function renderRepairOps(diff) {
  const adds = Array.isArray(diff?.adds) ? diff.adds : [];
  const removes = Array.isArray(diff?.removes) ? diff.removes : [];
  if (adds.length || removes.length) {
    return { ok: false, reason: "a repair never adds or removes posts", adds: adds.length, removes: removes.length };
  }
  const members = [];
  for (const u of Array.isArray(diff?.updates) ? diff.updates : []) {
    const op = { op: "update", ref: u.ref };
    for (const k of changedTopKeys(u.before, u.after)) op[k] = u.after[k];
    members.push(op);
  }
  return { ok: true, members };
}
