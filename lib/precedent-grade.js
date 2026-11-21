// ── Precedent grading (widen-deputy-to-personal-domains 2.2-2.4) ────────────
//
// A precedent is only worth what its provenance is worth. The discipline this
// module encodes:
//
//   owner-authored                 — the owner wrote it themselves (typed reply, no agent draft)
//   owner-approved                 — the owner sent the agent's draft VERBATIM
//   agent-independent              — an agent decided; the independence graph
//                                    holds (see classifyIndependence) and a
//                                    blind cross-model grader checked it
//   agent-independent-unverified   — same graph, but nobody checked it
//   agent-self                     — an agent decided with the graph violated
//                                    (its own proposal, its own signature, or
//                                    a cyclic chain)
//
// Why an agent's own ruling is not citable: a draft the owner sends unmodified
// reads, to everyone downstream, as the owner's own words. Feeding those back
// as precedent makes the agent progressively agree with itself while the
// record looks like the owner's judgement.
//
// Why an EDITED draft is graded below the owner tiers: we can record "the
// parameters were changed" but not how much. A one-character fix and a full
// rewrite are indistinguishable, so the honest grade is the conservative one.
// This is the same direction as the migration backfill.
//
// Leaf module: imports nothing.

export const GRADES = Object.freeze({
  OWNER_AUTHORED: "owner-authored",
  OWNER_APPROVED: "owner-approved",
  // An agent decided, and the independence graph holds: proposer ≠ decider ≠
  // grader, the grader ran a different model on a blind input, and the
  // coordinate chain has no cycle. Two grades because "verified" and
  // "nobody checked" are different facts — collapsing them into one bit is
  // how a precedent library stops being able to tell them apart.
  AGENT_INDEPENDENT: "agent-independent",
  AGENT_INDEPENDENT_UNVERIFIED: "agent-independent-unverified",
  // An agent decided, but the graph does NOT hold (proposer == decider, or a
  // cycle). This is the successor of `deputy-ruled` on the write side.
  AGENT_SELF: "agent-self",
  // Legacy value written by every version before agent-decided-learning-loop.
  // Kept so historical rows still read (classifyLegacyDecision still emits it);
  // normalizeLegacyGrade() maps it to AGENT_SELF at the read face.
  DEPUTY_RULED: "deputy-ruled",
});

const CITABLE = new Set([
  GRADES.OWNER_AUTHORED,
  GRADES.OWNER_APPROVED,
  GRADES.AGENT_INDEPENDENT,
  GRADES.AGENT_INDEPENDENT_UNVERIFIED,
]);

export function isCitableGrade(grade) {
  return CITABLE.has(grade);
}

export function citableGrades() {
  return [...CITABLE];
}

// ── Actor coordinates (agent-decided-learning-loop D2) ──────────────────────
//
// A ruling actor is an ADDRESS, not a role word. `"deputy"` said WHO in the
// org chart but not WHICH post, so two fleets' deputies were indistinguishable
// in the record — and the independence graph needs comparable coordinates.
//
// Shape: `agent:<fleetId>/<memberId>`. Owner rulings keep the literal
// `"owner"`; everything historical keeps its literal too (readers normalize).

const AGENT_PREFIX = "agent:";

export function agentCoord(fleetId, memberId) {
  if (!fleetId || !memberId) return null;
  return `${AGENT_PREFIX}${fleetId}/${memberId}`;
}

export function isAgentCoord(value) {
  return typeof value === "string" && value.startsWith(AGENT_PREFIX);
}

/**
 * Read-side predicate for "an agent decided this", spanning both the
 * coordinate form and the historical literals (`deputy`). Callers that only
 * need "was this an agent ruling" must use this instead of comparing to one
 * literal — the literal changed shape, and a missed comparison here reads as
 * "the deputy did nothing".
 */
export function isAgentRuling(resolvedBy) {
  return isAgentCoord(resolvedBy) || resolvedBy === "deputy";
}

/**
 * Read-side normalizer (design D4). Historical rows carry `deputy-ruled`,
 * which predates the independence graph, so it can never be re-derived — the
 * honest reading is `agent-self`: nobody established that it was independent.
 * Deliberately not a migration: rewriting those rows would mean inventing a
 * production path for them after the fact.
 */
export function normalizeLegacyGrade(grade) {
  return grade === GRADES.DEPUTY_RULED ? GRADES.AGENT_SELF : grade;
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

// ── Independence graph (agent-decided-learning-loop D1/D2) ───────────────────
//
// The question this answers is NOT "was a human present" — it is "could this
// conclusion have been its own evidence". The failure it must catch is the one
// `deputy-ruled` was invented for: a record that reads like an independent
// judgement while actually being the author agreeing with itself.
//
// Five conditions, ALL required for `ok`:
//
//   proposer ≠ decider                     nobody signs their own proposal
//   decider  ≠ grader                      nobody certifies their own ruling
//   grader.model ≠ decider.model           a second call to the same model is
//                                          not a second opinion
//   grader input is blind                  no proposer narrative, no motive
//   the coordinate chain has no cycle      the three seats are not the same
//                                          body wearing three names
//
// The last one is the one a naive `≠` check misses: one fleet can fill three
// DISTINCT member ids and still be one author. A cycle means the chain returns
// to a coordinate it already visited — which is what "same body" looks like
// once you stop treating identity as a scalar.
//
// `verified` is a separate fact from `ok`. A ruling with no grader is still
// independent (nobody's own word is backing it) but nobody has checked it
// either, and the grade says so instead of pretending the two are the same.

const MAX_CHAIN_HOPS = 3;

const sameCoord = (a, b) => Boolean(a) && Boolean(b) && String(a) === String(b);

/**
 * Compute the independence graph for one ruling.
 *
 * @param {{
 *   proposer?: string|null,
 *   decider?: string|null,
 *   grader?: string|null,
 *   deciderModel?: string|null,
 *   graderModel?: string|null,
 *   blind?: boolean,
 *   chain?: string[]|null,   // optional full chain when it is longer than 3 seats
 * }} input coordinate strings; callers resolve them (this module reads no DB)
 * @returns {{grade: string, independence: object}}
 */
export function classifyIndependence(input) {
  const { proposer = null, decider = null, grader = null } = input ?? {};
  const deciderModel = normalizeModel(input?.deciderModel);
  const graderModel = normalizeModel(input?.graderModel);
  const hasGrader = Boolean(grader);

  const proposerNeDecider = Boolean(proposer) && Boolean(decider) ? !sameCoord(proposer, decider) : false;
  // No grader means the condition is vacuously satisfied — there is no second
  // signature to compare. `verified` carries the "nobody checked" fact instead.
  const deciderNeGrader = hasGrader ? !sameCoord(decider, grader) : true;
  const modelDiffers = hasGrader ? Boolean(deciderModel) && Boolean(graderModel) && deciderModel !== graderModel : false;
  const blind = input?.blind === true;

  const chain = buildChain({ proposer, decider, grader, chain: input?.chain });
  const cycleAt = firstRepeatedCoord(chain);

  // The three SEAT conditions decide `ok`. Verification quality decides
  // `verified` — and only that. A grader who ran the same model, or who saw
  // the proposer's recommendation, has failed to VERIFY; the ruling itself is
  // still nobody-signing-their-own-work. Collapsing the two into one boolean
  // would push every checked-but-imperfectly ruling down to `agent-self`,
  // i.e. the system would be harshest on the rulings it checked hardest —
  // exactly the inversion the `-unverified` grade exists to prevent.
  const ok = proposerNeDecider && deciderNeGrader && cycleAt === null;
  const verified = hasGrader && modelDiffers && blind && deciderNeGrader;

  let grade;
  if (!ok) grade = GRADES.AGENT_SELF;
  else grade = verified ? GRADES.AGENT_INDEPENDENT : GRADES.AGENT_INDEPENDENT_UNVERIFIED;

  return {
    grade,
    independence: {
      proposer: proposer ?? null,
      decider: decider ?? null,
      grader: grader ?? null,
      deciderModel,
      graderModel,
      proposer_ne_decider: proposerNeDecider,
      decider_ne_grader: deciderNeGrader,
      model_differs: modelDiffers,
      blind,
      acyclic: cycleAt === null,
      cycleAt,
      ok,
      verified,
    },
  };
}

function normalizeModel(v) {
  const s = typeof v === "string" ? v.trim() : "";
  return s || null;
}

// The chain is seats in decision order. An explicit `chain` (a caller that
// knows more than the three seats) wins; otherwise it is the three seats,
// de-duplicated only for the repeat scan (not for the equality checks above —
// dropping a duplicate there would hide the very case we test for).
function buildChain({ proposer, decider, grader, chain }) {
  if (Array.isArray(chain) && chain.length) {
    return chain.map((c) => (c == null ? null : String(c))).filter(Boolean);
  }
  return [proposer, decider, grader].map((c) => (c == null ? null : String(c))).filter(Boolean);
}

// Walk at most MAX_CHAIN_HOPS seats; the first coordinate seen twice is the
// cycle. Three seats cannot exceed three hops, but an explicit chain can, and
// an over-long chain is reported as a cycle rather than silently truncated.
function firstRepeatedCoord(chain) {
  const seen = new Set();
  for (const coord of chain.slice(0, MAX_CHAIN_HOPS)) {
    if (seen.has(coord)) return coord;
    seen.add(coord);
  }
  if (chain.length > MAX_CHAIN_HOPS) return chain[MAX_CHAIN_HOPS];
  return null;
}

/**
 * Grade one ruling from its seats. This is the ONLY writer-side entry for
 * agent rulings from now on; `classifyProvenance` stays for the owner paths
 * and for callers that have nothing but `{resolvedBy, sourceKind, amended}`.
 *
 * `resolvedBy` is accepted for back-compat but is NOT consulted for the agent
 * branch: a record whose text says "owner" while proposer == decider is still
 * `agent-self` (the value is a claim, the seats are facts).
 */
export function classifyRuling(input) {
  const { resolvedBy } = input ?? {};
  // Owner paths keep their existing derivation untouched.
  if (resolvedBy === "owner") return { grade: classifyProvenance(input), independence: null };
  return classifyIndependence(input);
}

/**
 * Who may sign a promotion or a ruling (agent-decided-learning-loop D6).
 *
 * The rule is `independence.ok ∨ a human actor` — NOT "a human, always".
 * `independence.ok` is the same graph the grade is computed from, so the
 * authorization and the recorded grade can never disagree: a caller cannot be
 * admitted by one path and graded by another.
 *
 * An explicit reason comes back on refusal, naming WHICH condition failed —
 * "not independent" alone sends the caller hunting in the wrong place.
 */
export function authorizeActor({ resolvedBy = null, seats = null } = {}) {
  if (resolvedBy === "owner") return { ok: true, via: "human", grade: null, independence: null };
  const { grade, independence } = classifyIndependence(seats ?? {});
  if (independence?.ok) return { ok: true, via: "independence", grade, independence };
  const failed = [];
  if (!independence?.proposer_ne_decider) failed.push("提案者与裁决者是同一坐标");
  if (!independence?.decider_ne_grader) failed.push("裁决者与验证者是同一坐标");
  if (independence?.cycleAt) failed.push(`签名链成环（回到 ${independence.cycleAt}）`);
  return {
    ok: false,
    via: null,
    grade: grade ?? GRADES.AGENT_SELF,
    independence,
    reason: `independence does not hold: ${failed.join("；") || "no proposer/decider seats supplied"}`,
  };
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
