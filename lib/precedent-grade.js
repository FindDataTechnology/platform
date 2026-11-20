// ── Precedent grading (widen-deputy-to-personal-domains 2.2-2.4) ────────────
//
// A precedent is only worth what its provenance is worth. The discipline this
// module encodes:
//
//   owner-authored  — the owner wrote it themselves (typed reply, no agent draft)
//   owner-approved  — the owner sent the agent's draft VERBATIM
//   deputy-ruled    — the agent decided; never citable as precedent
//
// Why `deputy-ruled` is not citable: a draft the owner sends unmodified reads,
// to everyone downstream, as the owner's own words. Feeding those back as
// precedent makes the agent progressively agree with itself while the record
// looks like the owner's judgement.
//
// Why an EDITED draft is graded `deputy-ruled` rather than `owner-authored`:
// we can record "the parameters were changed" but not how much. A one-character
// fix and a full rewrite are indistinguishable, so the honest grade is the
// conservative one. This is the same direction as the migration backfill.
//
// Leaf module: imports nothing.

export const GRADES = Object.freeze({
  OWNER_AUTHORED: "owner-authored",
  OWNER_APPROVED: "owner-approved",
  DEPUTY_RULED: "deputy-ruled",
});

const CITABLE = new Set([GRADES.OWNER_AUTHORED, GRADES.OWNER_APPROVED]);

export function isCitableGrade(grade) {
  return CITABLE.has(grade);
}

export function citableGrades() {
  return [...CITABLE];
}

/**
 * Classify by the path that produced the record — never by what the agent says
 * it is.
 *
 *   { resolvedBy: 'deputy' }                                  → deputy-ruled
 *   { resolvedBy: 'owner', sourceKind: 'owner-direct' }       → owner-authored
 *   { resolvedBy: 'owner', sourceKind: 'agent-draft', amended: false }
 *                                                             → owner-approved
 *   { resolvedBy: 'owner', sourceKind: 'agent-draft', amended: true }
 *                                                             → deputy-ruled
 *   anything else / unknown                                   → deputy-ruled
 */
export function classifyProvenance(input) {
  // `= {}` would not cover an explicit null, and a null record is exactly the
  // case that must land on the conservative side instead of throwing.
  const { resolvedBy, sourceKind, amended } = input ?? {};
  if (resolvedBy === "deputy") return GRADES.DEPUTY_RULED;
  if (resolvedBy !== "owner") return GRADES.DEPUTY_RULED;
  if (sourceKind === "owner-direct") return GRADES.OWNER_AUTHORED;
  if (sourceKind === "agent-draft" && amended === false) return GRADES.OWNER_APPROVED;
  return GRADES.DEPUTY_RULED;
}

/**
 * 主人裁决的等级：由服务端**已有事实**推导（fix-precedent-grade-derivation）。
 *
 * 为什么需要它：实时路径原先只在调用方声明 `sourceKind` 时才能判出可引用等级，
 * 而管理面从不发这个字段 ⇒ 主人每一次亲手裁决都落成 `deputy-ruled` ⇒ 判例集
 * 永远为空 ⇒ 常务岗只能「无同类判例」自裁，学不到主人的口径（2026-11-13 实测：
 * 全库 346 条一律 deputy-ruled，含两条主人亲裁）。这是本仓第 N 次「字段只在服务端
 * 校验里存在、没人产出」——修法是让不变式不依赖别人记得发，而不是去补那个字段。
 *
 * 判据只用服务端本来就有的两项：该项的推荐值、决议的选择值。
 *   · 没有推荐值       → 主人只能自己判断              → owner-authored
 *   · 选择 ≠ 推荐      → 主人否决了代理的倾向          → owner-authored
 *     （驳回时 choice 为 null，天然落进这一支：不采纳推荐就是独立判断）
 *   · 选择 = 推荐      → 规格说的「原样发出代理的稿」  → owner-approved（可引用）
 *
 * 与 `classifyLegacyDecision` 的差别只在最后一支：存量回填把它判成
 * `deputy-ruled`（历史行分不清，保守是对的）；实时路径有产生路径可依，且规格
 * 明确 `owner-approved` 就是这一情形、且**可引用**，所以判可引用级。
 */
export function deriveOwnerGrade(input) {
  // `= {}` 不覆盖显式 null，而 null 是真实形态（LEFT JOIN / 损坏行）——必须落
  // 可引用侧而不是抛：这条函数只在「主人裁决」这一支被调用，事实缺失时最保守的
  // 判断仍是「这是主人的判断」，而不是把主人裁决降级成代理自裁。
  const { recommendation, resolution } = input ?? {};
  const rec = typeof recommendation === "string" && recommendation !== "" ? recommendation : null;
  if (!rec) return GRADES.OWNER_AUTHORED;
  const choice = resolution?.choice ?? null;
  return choice === rec ? GRADES.OWNER_APPROVED : GRADES.OWNER_AUTHORED;
}

/**
 * 存量回填的细分规则（2026-11-10 修订）。
 *
 * 迁移时一刀切记 `deputy-ruled` 是过度保守：**拍板车道里主人的裁决本身就是他
 * 的判断**——那条车道没有「代理起草、主人原样发出」这种情形（那是对外发言车道
 * 才有的）。一刀切会把主人自己做的裁决也废掉。
 *
 * 但也不能反向乐观。可用的判据只有行本身能证明的：
 *   · 主人裁决，且该项**没有推荐值** → 他只能自己判断 → owner-authored
 *   · 主人裁决，且**选择与推荐不同** → 他否决了代理的倾向 → owner-authored
 *   · 主人裁决，且选择**恰好等于**推荐 → 分不清是独立判断还是照抄 → deputy-ruled
 *
 * 「分不清就保守」这一条保留：宁可判例少，不可判例脏。
 */
export function classifyLegacyDecision(input) {
  // 与 classifyProvenance 同款：`= {}` 不覆盖显式 null，而 null 必须落保守侧
  // 而不是抛。DB 行整行为空是真实存在的形态（LEFT JOIN、损坏行、测试替身）。
  const { resolvedBy, recommendation, resolution } = input ?? {};
  if (resolvedBy === "deputy") return GRADES.DEPUTY_RULED;
  if (resolvedBy !== "owner") return GRADES.DEPUTY_RULED;
  const rec = typeof recommendation === "string" && recommendation !== "" ? recommendation : null;
  if (!rec) return GRADES.OWNER_AUTHORED;
  const choice = resolution?.choice ?? null;
  if (choice && choice !== rec) return GRADES.OWNER_AUTHORED;
  return GRADES.DEPUTY_RULED;
}

/**
 * Behavioural consistency: how often the agent's recommendation matched what
 * the owner actually decided.
 *
 * Sample = items the owner resolved AND that carried a recommendation; the
 * agent's own self-rulings are excluded on purpose — using them to prove the
 * agent reliable would be circular.
 *
 * A rejection counts as disagreement: the agent recommended something, the
 * owner did not take it. That is the conservative reading and it is the one
 * that feels right to an owner looking at the number.
 */
export function consistency(rows = []) {
  let samples = 0;
  let agrees = 0;
  for (const row of rows) {
    if (!row || row.resolvedBy !== "owner") continue;
    if (typeof row.recommendation !== "string" || row.recommendation === "") continue;
    if (row.state !== "approved" && row.state !== "rejected") continue;
    samples += 1;
    const choice = row.resolution?.choice ?? null;
    if (row.state === "approved" && choice === row.recommendation) agrees += 1;
  }
  return {
    samples,
    agrees,
    rate: samples === 0 ? null : agrees / samples,
  };
}

/**
 * The promotion gate: a domain may only move from `draft` to `act-notify` when
 * there is enough evidence. Returns { ok, reason, rate, samples }.
 *
 * Absent evidence is never permission — samples below the minimum refuse even
 * when the rate would be perfect.
 */
export function canPromoteToAuto(stats, { minRate = 0.8, minSamples = 20 } = {}) {
  if (!stats || !Number.isFinite(stats.samples) || stats.samples < minSamples) {
    return { ok: false, reason: "insufficient_samples", rate: stats?.rate ?? null, samples: stats?.samples ?? 0 };
  }
  if (!Number.isFinite(stats.rate) || stats.rate < minRate) {
    return { ok: false, reason: "rate_below_threshold", rate: stats.rate, samples: stats.samples };
  }
  return { ok: true, reason: null, rate: stats.rate, samples: stats.samples };
}
