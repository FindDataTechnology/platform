// 失败诊断（fleet-failure-diagnosis 1.x / 2.x / 3.x）。
// Run: node --test scripts/test-failure-diagnosis.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { groupFailures, diagnoseFailure, fallbackGap, GROUPS } from "../lib/failure-diagnosis.js";

const turn = (o) => ({ status: "failed", errorKind: "other", memberId: "m1", model: "deepseek-v4.1-flash", error: null, ...o });

test("分组四类之和等于失败总数，未命名类别落 other", () => {
  const turns = [
    ...Array(45).fill(0).map(() => turn({ errorKind: "budget" })),
    ...Array(32).fill(0).map(() => turn({ errorKind: "timeout" })),
    ...Array(19).fill(0).map(() => turn({ errorKind: "model_upstream" })),
    ...Array(4).fill(0).map(() => turn({ errorKind: "runtime_not_ready" })),
    { status: "ok", errorKind: null },
  ];
  const g = groupFailures(turns);
  assert.deepEqual(g, { budget: 45, timeout: 32, model_upstream: 19, other: 4, total: 100 });
  assert.equal(GROUPS.reduce((s, k) => s + g[k], 0), g.total);
});

test("零失败 ⇒ null（不渲染全零占位）", () => {
  assert.equal(groupFailures([{ status: "ok" }]), null);
  assert.equal(groupFailures([]), null);
});

test("预算诊断带额度占用与 fallback 声明", () => {
  const d = diagnoseFailure(turn({ errorKind: "budget" }), {
    member: { model: "deepseek-v4.1-flash", fallbackModel: null },
    budgets: [{ model: "deepseek-v4.1-flash", tier: "monthly", pct: 75.83 }],
  });
  assert.equal(d.covered, true);
  assert.equal(d.evidence.usagePct, 75.8);
  assert.equal(d.evidence.fallbackDeclared, false);
  assert.equal(d.action.op, "set-fallback");
});

test("额度表读不到 ⇒ 未取得而不是 0%", () => {
  const d = diagnoseFailure(turn({ errorKind: "budget" }), { member: { model: "x" }, budgets: null });
  assert.deepEqual(d.evidence.usagePct, { unavailable: "额度表不可用" });
  assert.notEqual(d.evidence.usagePct, 0);
});

test("超时区分软停与真超时", () => {
  const soft = diagnoseFailure(turn({ errorKind: "timeout", error: "turn stopped early — budget soft stop (480s of 600s)" }));
  const hard = diagnoseFailure(turn({ errorKind: "timeout", error: "turn timed out" }));
  assert.equal(soft.action.op, "raise-time-budget");
  assert.equal(hard.action.op, "raise-timeout");
  assert.match(soft.verdict, /叫停/);
});

test("上游故障给重试动作", () => {
  const d = diagnoseFailure(turn({ errorKind: "model_upstream", error: '503: {"message":"Service temporarily unavailable"}' }));
  assert.equal(d.action.op, "retry-later");
  assert.equal(d.covered, true);
});

test("未覆盖类别不猜测", () => {
  const d = diagnoseFailure(turn({ errorKind: "runtime_not_ready" }));
  assert.equal(d.covered, false);
  assert.equal(d.verdict, null);
  assert.equal(d.action, null);
  assert.equal(d.evidence.errorKind, "runtime_not_ready");
});

test("非失败回合没有诊断", () => {
  assert.equal(diagnoseFailure(turn({ status: "ok" })), null);
  assert.equal(diagnoseFailure(null), null);
});

test("备选模型缺口只数预算失败涉及的岗", () => {
  const turns = [
    turn({ errorKind: "budget", memberId: "a" }),
    turn({ errorKind: "budget", memberId: "b" }),
    turn({ errorKind: "budget", memberId: "a" }),
    turn({ errorKind: "timeout", memberId: "c" }),
  ];
  const g = fallbackGap(turns, { a: { fallbackModel: "glm-5.3-flash" }, b: { fallbackModel: null } });
  assert.deepEqual(g, { members: 2, missingFallback: 1, memberIds: ["a", "b"] });
  assert.equal(fallbackGap([turn({ errorKind: "timeout" })], {}), null);
});

test("未归类但文本是连接错误的，按上游处置（生产实测 17 条）", () => {
  const d = diagnoseFailure(turn({ errorKind: "other", error: "Connection error." }));
  assert.equal(d.covered, true);
  assert.equal(d.kind, "model_upstream");
  assert.equal(d.action.op, "retry-later");
});

test("真正的未归类文本仍不猜测", () => {
  const d = diagnoseFailure(turn({ errorKind: "other", error: 'malformed prompt variable reference "{{PACK_ID:x}}"' }));
  assert.equal(d.covered, false);
});

// 2026-11-27 生产实撞：检查器读的是每岗路由 /members/:mid/turns，我只给舰队级
// 那条加了诊断，于是「API 有、界面没有」。这条钉住两处同口径。
test("每岗与舰队级两条路由都必须挂诊断（生产实撞的形状）", async () => {
  const src = await (await import("node:fs/promises")).readFile(new URL("../server/routes/fleets.js", import.meta.url), "utf8");
  const memberRoute = src.slice(src.indexOf('router.get("/:id/members/:mid/turns"'), src.indexOf('router.get("/:id/members/:mid/turns"') + 3000);
  const fleetRoute = src.slice(src.indexOf('router.get("/:id/turns"'), src.indexOf('router.get("/:id/turns"') + 3000);
  assert.match(memberRoute, /diagnosis:\s*diagnoseFailure/, "每岗路由必须挂诊断");
  assert.match(fleetRoute, /diagnosis:\s*diagnoseFailure/, "舰队级路由必须挂诊断");
});

test("上下文压力导致的超时给收窄上下文的动作（生产 15 条）", () => {
  const d = diagnoseFailure(turn({ errorKind: "timeout", error: "turn timed out — context pressure (2 compactions)" }));
  assert.equal(d.action.op, "shrink-context");
  assert.match(d.verdict, /上下文/);
});

test("error_kind=other 但文本是 budget_exhausted ⇒ 按额度处置（生产 2422 行）", () => {
  const d = diagnoseFailure(turn({
    errorKind: "other",
    error: "budget_exhausted: all candidate models over daily/monthly budget (model 'deepseek-v4.1-flash' skipped: budget_exhausted)",
  }), { member: { model: "deepseek-v4.1-flash", fallbackModel: null }, budgets: [] });
  assert.equal(d.covered, true);
  assert.equal(d.kind, "budget");
  assert.equal(d.action.op, "set-fallback");
});

test("429「上游账号队列满」按上游处置（本周 59 次）", () => {
  const d = diagnoseFailure(turn({ errorKind: "other", error: '429: {"message":"Upstream account queue full, please retry later"}' }));
  assert.equal(d.covered, true);
  assert.equal(d.kind, "model_upstream");
  assert.equal(d.action.op, "retry-later");
});

// ── 预算证据（允许给特定岗位加大时间预算）────────────────────────────────
//
// 既有修复脑 lib/fleet-ops-manager.js 的 timeout 分支读 evidence.turnTimeoutMs
// 直接写 cadence；没有这条证据它只会回 insufficient evidence，修复永远发不出来。
// 生产实测：50 个未声明岗的 528 次软停最大用时都是 480s（= 600 × 0.8），即被软停
// 线掐掉；3 个已声明 30 分钟的岗同样软停在 480s，那种情形加预算无效。

test("软停且读到 600s 预算 ⇒ 建议 900s", () => {
  const d = diagnoseFailure(turn({
    errorKind: "timeout",
    error: "turn stopped early — budget soft stop (480s of 600s)",
    detail: { budgetMs: 600000 },
  }));
  assert.equal(d.evidence.currentBudgetMs, 600000);
  assert.equal(d.evidence.turnTimeoutMs, 900000);
  assert.equal(d.action.op, "raise-time-budget");
  assert.match(d.action.hint, /15 分钟/);
});

test("从错误文本读回预算（detail 缺失时）", () => {
  const d = diagnoseFailure(turn({ errorKind: "timeout", error: "turn stopped early — budget soft stop (480s of 600s)" }));
  assert.equal(d.evidence.currentBudgetMs, 600000);
  assert.equal(d.evidence.turnTimeoutMs, 900000);
});

test("已顶 30 分钟上限 ⇒ 不给建议值，动作是拆任务", () => {
  const d = diagnoseFailure(turn({
    errorKind: "timeout",
    error: "turn stopped early — budget soft stop (1440s of 1800s)",
    detail: { budgetMs: 1800000 },
  }));
  assert.equal(d.evidence.currentBudgetMs, 1800000);
  assert.equal(d.evidence.turnTimeoutMs, undefined);
  assert.equal(d.action.op, "split-task");
});

test("读不到预算 ⇒ 只说调高，不假装知道顶没顶到上限", () => {
  const d = diagnoseFailure(turn({ errorKind: "timeout", error: "turn timed out" }));
  assert.equal(d.evidence.currentBudgetMs, undefined);
  assert.equal(d.evidence.turnTimeoutMs, undefined);
  assert.equal(d.action.op, "raise-timeout");
});

test("上下文压力超时给收窄上下文，不给预算值", () => {
  const d = diagnoseFailure(turn({
    errorKind: "timeout",
    error: "turn timed out — context pressure (2 compactions)",
    detail: { budgetMs: 600000 },
  }));
  assert.equal(d.evidence.turnTimeoutMs, undefined);
  assert.equal(d.action.op, "shrink-context");
});

// 端到端：诊断的证据能否驱动既有修复脑落一条 cadence 改动。
// 这是「允许给特定岗位加大时间预算」的机械判据——不是新写一条写路径，
// 而是让已在仓里的 fleet-ops-manager 能吃到证据（它此前永远回
// insufficient evidence，因为诊断从不产出 turnTimeoutMs）。
test("诊断证据 → 修复脑产出 cadence.turnTimeoutMs 的 diff，且不动 cron/tz", async () => {
  const { repairDraft } = await import("../lib/fleet-ops-manager.js");
  const live = [{
    id: "m_1", title: "常务岗", targetKind: "persona", targetId: "deputy-1ei3ma",
    cadence: { cron: "0 */2 * * *", tz: "Asia/Shanghai", enabled: true }, model: null, fallbackModel: null,
  }];
  const d = diagnoseFailure(turn({
    errorKind: "timeout", memberId: "m_1",
    error: "turn stopped early — budget soft stop (480s of 600s)", detail: { budgetMs: 600000 },
  }), { member: null, budgets: null });
  const out = repairDraft({ diagnoses: [{ ref: "m_1", errorKind: d.kind, evidence: d.evidence }], liveRows: live, modelRoster: [] });
  assert.equal(out.ok, true, JSON.stringify(out.missingEvidence));
  const after = out.diff.updates[0].after.cadence;
  assert.equal(after.turnTimeoutMs, 900000);
  assert.equal(after.cron, "0 */2 * * *");
  assert.equal(after.tz, "Asia/Shanghai");
});

test("已顶上限的岗不给证据 ⇒ 修复脑如实回 insufficient evidence，不瞎改", async () => {
  const { repairDraft } = await import("../lib/fleet-ops-manager.js");
  const live = [{
    id: "m_2", title: "台账主编", targetKind: "persona", targetId: "x",
    cadence: { cron: "0 8 * * *", turnTimeoutMs: 1800000 }, model: null, fallbackModel: null,
  }];
  const d = diagnoseFailure(turn({
    errorKind: "timeout", memberId: "m_2",
    error: "turn stopped early — budget soft stop (1440s of 1800s)", detail: { budgetMs: 1800000 },
  }), { member: null, budgets: null });
  const out = repairDraft({ diagnoses: [{ ref: "m_2", errorKind: d.kind, evidence: d.evidence }], liveRows: live, modelRoster: [] });
  assert.equal(out.ok, false);
  assert.match(JSON.stringify(out.missingEvidence), /no turn-timeout evidence/);
});
