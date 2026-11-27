// ── 判定裁决（establish-agent-role-and-fitness-plane 3.2 / 3.3 / 3.4）──────────
//
// 纯函数：一组「臂」的读数进，一个闭集裁决出。不读库、不碰时钟、不调模型——
// 这样「同一输入重算得同一裁决」（agent-fitness-verdict spec）是可验的，而不是
// 一个愿望。
//
// 为什么裁决必须在这里算，而不是让模型写一段结论：
//   裁决直接影响「这份包能不能新装」。一个由模型自由撰写的判决无法复算，也无法
//   证伪；而这份 spec 的全部价值就是「能证伪」。模型只在 llm-judged 那一栏里
//   有票，且那一栏**不参与裁决方向**（见 splitCriteria）。
//
// 三个决定形状的事实：
//   1. **同预算**是硬约束，不是注释。臂之间预算不一致 ⇒ 直接 inconclusive，
//      因为「多花的钱换来更好的质量」不是胜利，是不可比。
//   2. **预算违约**单独一档（`budget_violation`）：超预算却质量更高，裁决不得
//      为 retain。这是「预算即分母」的唯一落法。
//   3. **判不出要指明缺什么**：`missing[]` 是给人读的下一步，也是下一次判定的
//      输入。缺数不是通过（fleet-acceptance-readings 同族规则）。

export const VERDICTS = Object.freeze(["retain", "merge", "retire", "redesign", "inconclusive"]);

export const ARM_KINDS = Object.freeze(["control", "team", "ablation"]);

/**
 * 判据分栏：确定性与模型判据**分开计分**，不得合成总分。
 *
 * `deterministic` 的每一条必须是「重算得同一个数」的（回合数、失败率、缺报率、
 * 成本、时延）。`judged` 只作参考证据，且单独标出被判了几条。
 */
export function splitCriteria(readings = {}) {
  return {
    deterministic: {
      turns: readings.turns ?? null,
      failureRate: readings.failureRate ?? null,
      reportGapRate: readings.reportGapRate ?? null,
      costUsd: readings.costUsd ?? null,
      queueWaitMsP50: readings.queueWaitMsP50 ?? null,
    },
    judged: {
      assertions: readings.judgedAssertions ?? null,
      passed: readings.judgedPassed ?? null,
    },
  };
}

/** 一条臂的预算 → 运行期可执行的形状。缺省 = 未声明（调用方必须拒绝，不能猜）。 */
export function normalizeBudget(raw) {
  if (!raw || typeof raw !== "object") return null;
  const turns = Number(raw.turnsPerDay);
  const tokens = Number(raw.tokensPerTurn);
  if (!Number.isFinite(turns) || turns <= 0 || !Number.isFinite(tokens) || tokens <= 0) return null;
  return { turnsPerDay: Math.floor(turns), tokensPerTurn: Math.floor(tokens), maxTokens: Math.floor(turns * tokens) };
}

/**
 * 三臂是否真的可比。三种不可比：
 *   · 缺臂（少于两条：没有对照就无从比较）
 *   · 预算不一致（同预算是多臂判定的前提）
 *   · 任一臂未声明预算（「没写」不等于「和大家一样」）
 */
export function comparability(arms = []) {
  const problems = [];
  if (!Array.isArray(arms) || arms.length < 2) problems.push("fewer-than-two-arms");
  else if (!arms.some((a) => a.kind === "control")) problems.push("no-control-arm");
  const budgets = arms.map((a) => normalizeBudget(a.budget));
  if (arms.length >= 2 && budgets.some((b) => b === null)) problems.push("arm-without-budget");
  else if (budgets.length >= 2) {
    const first = budgets[0];
    if (budgets.some((b) => b.turnsPerDay !== first.turnsPerDay || b.tokensPerTurn !== first.tokensPerTurn)) {
      problems.push("budgets-differ");
    }
  }
  return { ok: problems.length === 0, problems };
}

/** 一条臂超没超预算。observed 缺失 ⇒ 判不出（不是「没超」）。 */
export function budgetViolation(arm) {
  const budget = normalizeBudget(arm?.budget);
  if (!budget) return { state: "undeclared" };
  const tokens = Number(arm?.observed?.tokens);
  const turns = Number(arm?.observed?.turns);
  if (!Number.isFinite(tokens) && !Number.isFinite(turns)) return { state: "unknown" };
  const overTokens = Number.isFinite(tokens) && budget.maxTokens > 0 && tokens > budget.maxTokens;
  const overTurns = Number.isFinite(turns) && budget.turnsPerDay > 0 && turns > budget.turnsPerDay;
  return { state: overTokens || overTurns ? "violated" : "within", tokens, turns, maxTokens: budget.maxTokens, turnsPerDay: budget.turnsPerDay };
}

/**
 * 裁决。**顺序是有意义的**，每一条都在挡一种「看起来更好」的假胜利：
 *
 *   1. 不可比 ⇒ inconclusive（缺臂/预算不一致）
 *   2. 任一臂预算违约 ⇒ 该臂不得为胜者；若是对照臂违约 ⇒ inconclusive
 *   3. 无确定性 gold ⇒ inconclusive（模型判据不得独自支撑裁决）
 *   4. 团队臂 ≤ 对照臂（按确定性判据，逐条比较，任一更差即不算更好）⇒ merge/retire
 *   5. 团队臂确实更好，且消融显示有岗无独立贡献 ⇒ merge（好但可更省）
 *   6. 否则 retain
 */
export function evaluateVerdict({ arms = [] } = {}) {
  const cmp = comparability(arms);
  if (!cmp.ok) return { verdict: "inconclusive", reasons: cmp.problems, missing: missingFor(cmp.problems) };

  const control = arms.find((a) => a.kind === "control");
  const team = arms.find((a) => a.kind === "team");
  if (!control || !team) return { verdict: "inconclusive", reasons: ["no-control-arm"], missing: missingFor(["no-control-arm"]) };

  const violations = arms.map((a) => ({ ref: a.ref ?? a.kind, ...budgetViolation(a) }));
  if (violations.some((v) => v.state === "undeclared")) return { verdict: "inconclusive", reasons: ["arm-without-budget"], missing: missingFor(["arm-without-budget"]) };
  if (violations.some((v) => v.state === "unknown")) return { verdict: "inconclusive", reasons: ["arm-usage-unknown"], missing: missingFor(["arm-usage-unknown"]) };
  if (violations.find((v) => v.ref === (control.ref ?? "control"))?.state === "violated") {
    // 对照臂超预算 ⇒ 基准本身不成立，不能拿它比。
    return { verdict: "inconclusive", reasons: ["control-budget-violated"], missing: missingFor(["control-budget-violated"]) };
  }
  const teamsOverBudget = violations.filter((v) => v.state === "violated" && v.ref !== (control.ref ?? "control"));
  if (teamsOverBudget.length) {
    return { verdict: "inconclusive", reasons: ["arm-budget-violated"], missing: missingFor(["arm-budget-violated"]) };
  }

  const c = splitCriteria(control.readings).deterministic;
  const t = splitCriteria(team.readings).deterministic;
  const goldMissing = ["failureRate", "reportGapRate"].filter((k) => c[k] === null || t[k] === null);
  if (goldMissing.length) {
    return { verdict: "inconclusive", reasons: ["no-deterministic-gold"], missing: goldMissing.map((k) => `确定性判据缺失：${k}`) };
  }

  // 「更好」= 失败率不更差 且 缺报率不更差 且 至少一项严格更好；成本更低算更好的一维。
  const notWorse =
    t.failureRate <= c.failureRate && t.reportGapRate <= c.reportGapRate && (c.costUsd === null || t.costUsd === null || t.costUsd <= c.costUsd);
  const strictlyBetter =
    t.failureRate < c.failureRate || t.reportGapRate < c.reportGapRate || (c.costUsd !== null && t.costUsd !== null && t.costUsd < c.costUsd);

  if (!notWorse || !strictlyBetter) {
    // 团队没有胜过对照。再问一句：是「多岗无益」（retire 多出来的岗）还是「分工可合并」。
    const ablations = arms.filter((a) => a.kind === "ablation");
    const noLossAblations = ablations.filter((a) => ablationLosesNothing(a, team));
    if (noLossAblations.length) {
      return {
        verdict: "retire",
        reasons: ["team-not-better-than-control", "ablation-no-loss"],
        noLoss: noLossAblations.map((a) => a.ref ?? a.memberRef ?? "ablation"),
        missing: [],
      };
    }
    return { verdict: "merge", reasons: ["team-not-better-than-control"], missing: [] };
  }

  // 团队确实更好：仍要看有没有岗是白搭的——能更省而不损，就该合并。
  const ablations = arms.filter((a) => a.kind === "ablation");
  const noLoss = ablations.filter((a) => ablationLosesNothing(a, team));
  if (noLoss.length) {
    return {
      verdict: "merge",
      reasons: ["team-better-but-ablation-no-loss"],
      noLoss: noLoss.map((a) => a.ref ?? a.memberRef ?? "ablation"),
      missing: [],
    };
  }
  if (!ablations.length) {
    // 没有消融臂也能判 retain，但要如实说「合并/裁撤这一维没证据」。
    return { verdict: "retain", reasons: ["team-better-than-control"], missing: ["消融臂：没有它只能判保留，判不了该不该合并"] };
  }
  return { verdict: "retain", reasons: ["team-better-than-control"], missing: [] };
}

/** 消融臂相对团队臂「有没有丢东西」：丢东西 ⇒ 该岗有独立贡献。 */
export function ablationLosesNothing(ablation, team) {
  const a = splitCriteria(ablation?.readings).deterministic;
  const t = splitCriteria(team?.readings).deterministic;
  if (a.failureRate === null || t.failureRate === null) return false; // 判不出 ⇒ 不能说它没贡献
  const worse = a.failureRate > t.failureRate || (a.reportGapRate !== null && t.reportGapRate !== null && a.reportGapRate > t.reportGapRate);
  return !worse;
}

function missingFor(problems) {
  const map = {
    "fewer-than-two-arms": ["对照臂：单 agent 全预算", "被测臂：团队（同预算）"],
    "no-control-arm": ["对照臂：单 agent 全预算"],
    "arm-without-budget": ["每条臂的 budget（turnsPerDay × tokensPerTurn）"],
    "budgets-differ": ["统一预算：臂之间预算不同则不可比"],
    "arm-usage-unknown": ["每臂的实际用量（tokens/turns），否则判不了有没有超预算"],
    "control-budget-violated": ["一个不超预算的对照臂"],
    "arm-budget-violated": ["在预算内完成的被测臂"],
    "no-deterministic-gold": ["确定性 gold（回合/报数账本读数）"],
  };
  return problems.flatMap((p) => map[p] ?? [p]);
}

/** 裁决是否允许进入新装路径（发布面用；publish 侧的 S8 读它）。 */
export function isInstallable(verdict) {
  return verdict !== "retire";
}
