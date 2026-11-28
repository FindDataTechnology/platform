// 失败诊断（fleet-failure-diagnosis）：把 error_kind 变成一句人话 + 一条动作。
//
// 纯函数，证据全部来自调用方传入的既有记录——本模块不读库、不写库、不新起判据。
// 覆盖实测里占 96% 的三类：budget（45%）/ timeout（32%）/ model_upstream（19%）。
// 未覆盖的类别如实返回 {covered:false}，绝不套用最近的一类。

export const COVERED = Object.freeze(["budget", "timeout", "model_upstream"]);
export const GROUPS = Object.freeze(["budget", "timeout", "model_upstream", "other"]);

// 已知的「上游没连上」形态。生产实测（2026-11-27，1500 回合）：17 条
// `Connection error.` 被记成 other，处置与 503 完全相同，却进了没有动作的桶。
// 归因只读错误文本，不改 error_kind 的落库口径——落库那头归写库方管。
const UPSTREAM_TEXT = /connection error|ECONNRESET|ECONNREFUSED|socket hang up|upstream_error|APIConnectionError|Upstream account queue full|upstream.*queue full/i;

// 额度耗尽的文本形态。生产实测 2026-11-27：2487 行错误文本含
// `budget_exhausted: all candidate models over daily/monthly budget`，其中
// 2422 行的 `error_kind` 是 `other`（分类器当时还没把它归到 budget），
// 只有 57 行标对了。没有这条兜底，最大的一类失败会在诊断里显示「无诊断」。
const BUDGET_TEXT = /budget_exhausted|all candidate models over daily\/monthly budget/i;

// 单轮预算的可调区间，与 server/cron-runner.js 的 clampBudgetMs 同源（2–30 分钟）。
// 不一致会让诊断提出一个写面会 clamp 掉的建议值——提案与落地各说一套。
export const TURN_BUDGET_FLOOR_MS = 2 * 60 * 1000;
export const TURN_BUDGET_CEILING_MS = 30 * 60 * 1000;

/** 从 "…(480s of 600s)" 里读回硬上限；读不到返回 NaN。 */
export function budgetFromText(reason) {
  const m = /\(\d+s of (\d+)s\)/.exec(String(reason ?? ""));
  if (!m) return NaN;
  return Number(m[1]) * 1000;
}

/**
 * 建议的新预算：当前 × 1.5，夹在 2–30 分钟。
 * 返回 null =「加了也没意义」（已到上限，或读不到当前值）。
 *
 * 生产实测 2026-11-27：50 个未声明岗的 528 次软停，最大用时全是 480s
 * （= 600 × 0.8 软停比）——它们是被软停线掐掉的，不是真跑不完。×1.5 把
 * 硬上限抬到 900s、软停线随之从 480s 抬到 720s，正好越过实际用时。
 * 已顶到 30 分钟仍软停的岗不给值：那种情形需要拆任务，加预算只会让每轮
 * 更久地占着上游（本周 429「上游账号队列满」已是第二大失败原因）。
 */
export function proposeTurnBudget(currentBudgetMs) {
  const cur = Number(currentBudgetMs);
  if (!Number.isFinite(cur) || cur <= 0) return null;
  const next = Math.min(Math.max(Math.round(cur * 1.5), TURN_BUDGET_FLOOR_MS), TURN_BUDGET_CEILING_MS);
  return next > cur ? next : null;
}

/** 一条失败回合的有效类别：先信 error_kind，未覆盖的按错误文本兜底归到覆盖集。 */
export function effectiveKind(turn) {
  const k = turn?.errorKind ?? null;
  if (COVERED.includes(k)) return k;
  const text = String(turn?.error ?? "");
  if (BUDGET_TEXT.test(text)) return "budget";
  if (UPSTREAM_TEXT.test(text)) return "model_upstream";
  return "other";
}

// 失败分组：四组之和恒等于总数（other 兜住一切未命名类别）。
// 空输入返回 null——「没有失败」与「四组都是 0」是两件事，前者不渲染。
export function groupFailures(turns) {
  const failed = (turns ?? []).filter((t) => t.status === "failed");
  if (!failed.length) return null;
  const counts = { budget: 0, timeout: 0, model_upstream: 0, other: 0 };
  for (const t of failed) counts[effectiveKind(t)] += 1;
  return { ...counts, total: failed.length };
}

const un = (reason) => ({ unavailable: reason });

/**
 * 单条失败回合的诊断。
 *
 * @param turn        deserializeTurnEvent 的形状（需要 status/errorKind/model/detail）
 * @param ctx.member  该岗的声明（model / fallbackModel），可缺
 * @param ctx.budgets 读面给的额度占用 [{model, tier, used, limit, pct}]，或 null 表示读不到
 */
export function diagnoseFailure(turn, ctx = {}) {
  if (!turn || turn.status !== "failed") return null;
  const kind = effectiveKind(turn);

  if (kind === "budget") {
    const budgets = ctx.budgets;
    const model = turn.model ?? ctx.member?.model ?? null;
    const row = Array.isArray(budgets) && model ? budgets.find((b) => b.model === model && b.tier === "monthly") ?? budgets.find((b) => b.model === model) : null;
    return {
      covered: true,
      kind,
      verdict: "所有候选模型都超出日/月额度，本轮无法执行",
      evidence: {
        model,
        usagePct: Array.isArray(budgets) ? (row ? Math.round(row.pct * 10) / 10 : un("该模型无额度记录")) : un("额度表不可用"),
        fallbackDeclared: ctx.member ? Boolean(ctx.member.fallbackModel) : un("岗位声明不可读"),
      },
      action: { op: "set-fallback", hint: "为这些岗位配置备选模型；额度表里仍有高余量的模型可直接选用" },
    };
  }

  if (kind === "timeout") {
    const reason = String(turn.error ?? "");
    const softStop = /budget soft stop/i.test(reason);
    // 上下文压力导致的超时（生产实测 15 条 "turn timed out — context pressure
    // (N compactions)"）处置与单纯超时不同：调超时没用，要收窄上下文。
    const pressure = /context pressure/i.test(reason);
    // 预算相关（软停或真超时）才给「加多少」的证据：既有修复脑
    // lib/fleet-ops-manager.js 的 timeout 分支读 evidence.turnTimeoutMs 直接落 cadence。
    // 没有这条证据它只会回 insufficient evidence，修复永远发不出来。
    const currentBudget = Number(turn?.detail?.budgetMs) || budgetFromText(reason);
    const known = Number.isFinite(currentBudget) && currentBudget > 0;
    const proposed = pressure ? null : proposeTurnBudget(currentBudget);
    // 三态，不合并：读到预算且有余量 ⇒ 给数；读到预算但已顶上限 ⇒ 拆任务；
    // 读不到预算 ⇒ 只说「调高」，不假装知道顶没顶到上限。
    const atCeiling = known && !proposed;
    return {
      covered: true,
      kind,
      verdict: softStop
        ? "回合撞到预算软停的时间上限被中止（不是失败，是被叫停）"
        : pressure
          ? "回合因上下文反复压缩耗尽时间而超时"
          : "回合超时未完成",
      evidence: {
        reason: reason.slice(0, 200) || un("错误文本为空"),
        ...(Number.isFinite(currentBudget) && currentBudget > 0 ? { currentBudgetMs: currentBudget } : {}),
        // 已顶到上限时省略 —— 让修复器如实回 missing，而不是提一个加不动的值。
        ...(proposed ? { turnTimeoutMs: proposed } : {}),
      },
      action: pressure
        ? { op: "shrink-context", hint: "收窄该岗的上下文预算或任务范围；只调超时不会好转" }
        : proposed
          ? { op: softStop ? "raise-time-budget" : "raise-timeout", hint: `把该岗单轮预算提到约 ${Math.round(proposed / 60000)} 分钟` }
          : atCeiling
            ? { op: "split-task", hint: "该岗已顶到 30 分钟上限仍被叫停——需要拆分任务，加预算无效" }
            : { op: "raise-timeout", hint: "调高回合超时上限；若反复超时，先看该岗是否在做超大范围检索" },
    };
  }

  if (kind === "model_upstream") {
    return {
      covered: true,
      kind,
      verdict: "模型上游不可用（503/502），与岗位配置无关",
      evidence: { reason: String(turn.error ?? "").slice(0, 200) || un("错误文本为空") },
      action: { op: "retry-later", hint: "上游故障，重试即可；同一模型连续多轮出现时应切到备选模型" },
    };
  }

  // 未覆盖：kind 报原文（不是归组后的 other），否则「没诊断」会变成「诊断成 other」。
  return {
    covered: false,
    kind: turn.errorKind ?? "other",
    verdict: null,
    evidence: { errorKind: turn.errorKind ?? un("未记录") },
    action: null,
  };
}

/** 备选模型缺口：预算失败涉及的岗位里，没有声明 fallback 的有多少个。 */
export function fallbackGap(turns, membersById) {
  const failedBudget = (turns ?? []).filter((t) => t.status === "failed" && t.errorKind === "budget");
  if (!failedBudget.length) return null;
  const ids = [...new Set(failedBudget.map((t) => t.memberId))];
  const missing = ids.filter((id) => !membersById?.[id]?.fallbackModel);
  return { members: ids.length, missingFallback: missing.length, memberIds: ids };
}
