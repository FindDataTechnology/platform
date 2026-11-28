// 裁决（establish-agent-role-and-fitness-plane 3.2 / 3.3 / 3.4）。
//
// 每一条用例都在挡一种「看起来更好」的假胜利。这里没有一条是纯形状检查：
// 全部是「某种具体的坏设计会让你判出一个错裁决」。
//
// Run: node --test lib/fitness-verdict.test.js

import assert from "node:assert/strict";
import { test } from "node:test";

const { evaluateVerdict, comparability, budgetViolation, normalizeBudget, splitCriteria, VERDICTS, isInstallable } = await import("./fitness-verdict.js");

const budget = { turnsPerDay: 3, tokensPerTurn: 60000 };
const arm = (kind, readings, over = {}) => ({ kind, budget, observed: { tokens: 1000, turns: 1 }, readings, ...over });
const R = (over = {}) => ({ turns: 10, failureRate: 0.1, reportGapRate: 0.1, costUsd: 1, queueWaitMsP50: 100, ...over });

test("少于两条臂 ⇒ 判不出，且指明缺对照臂", () => {
  const v = evaluateVerdict({ arms: [arm("team", R())] });
  assert.equal(v.verdict, "inconclusive");
  assert.ok(v.missing.some((m) => m.includes("对照臂")));
});

test("预算不一致 ⇒ 判不出（多花的钱换来更好质量不是胜利）", () => {
  const v = evaluateVerdict({
    arms: [arm("control", R()), arm("team", R(), { budget: { turnsPerDay: 6, tokensPerTurn: 60000 } })],
  });
  assert.equal(v.verdict, "inconclusive");
  assert.ok(v.reasons.includes("budgets-differ"));
});

test("任一臂未声明预算 ⇒ 判不出（没写不等于和大家一样）", () => {
  const v = evaluateVerdict({ arms: [arm("control", R()), { kind: "team", readings: R(), observed: { tokens: 1, turns: 1 } }] });
  assert.equal(v.verdict, "inconclusive");
  assert.ok(v.reasons.includes("arm-without-budget"));
});

test("被测臂超预算 ⇒ 判不出，绝不 retain", () => {
  const v = evaluateVerdict({
    arms: [arm("control", R()), arm("team", R({ failureRate: 0.01 }), { observed: { tokens: 999999, turns: 1 } })],
  });
  assert.equal(v.verdict, "inconclusive");
  assert.ok(v.reasons.includes("arm-budget-violated"));
});

test("对照臂超预算 ⇒ 判不出（基准本身不成立）", () => {
  const v = evaluateVerdict({
    arms: [arm("control", R(), { observed: { tokens: 999999, turns: 1 } }), arm("team", R({ failureRate: 0.01 }))],
  });
  assert.equal(v.verdict, "inconclusive");
  assert.ok(v.reasons.includes("control-budget-violated"));
});

test("用量未知 ⇒ 判不出（判不了有没有超预算）", () => {
  const v = evaluateVerdict({ arms: [arm("control", R(), { observed: {} }), arm("team", R())] });
  assert.equal(v.verdict, "inconclusive");
  assert.ok(v.reasons.includes("arm-usage-unknown"));
});

test("无确定性 gold ⇒ 判不出（模型判据不得独自支撑裁决）", () => {
  const v = evaluateVerdict({
    arms: [
      arm("control", R({ failureRate: null })),
      arm("team", R({ failureRate: null, judgedPassed: 9, judgedAssertions: 10 })),
    ],
  });
  assert.equal(v.verdict, "inconclusive");
  assert.ok(v.reasons.includes("no-deterministic-gold"));
});

test("团队不优于对照 ⇒ merge（默认方向是不该扩编）", () => {
  const v = evaluateVerdict({ arms: [arm("control", R({ failureRate: 0.1 })), arm("team", R({ failureRate: 0.1 }))] });
  assert.equal(v.verdict, "merge");
});

test("团队更差 ⇒ merge，且不会因为模型判据好看而翻盘", () => {
  const v = evaluateVerdict({
    arms: [
      arm("control", R({ failureRate: 0.1 })),
      arm("team", R({ failureRate: 0.3, judgedAssertions: 10, judgedPassed: 10 })),
    ],
  });
  assert.equal(v.verdict, "merge");
});

test("团队更好但消融无损失 ⇒ merge（能更省就该合并）", () => {
  const v = evaluateVerdict({
    arms: [
      arm("control", R({ failureRate: 0.2 })),
      arm("team", R({ failureRate: 0.1 })),
      arm("ablation", R({ failureRate: 0.1 }), { ref: "drop-watcher" }),
    ],
  });
  assert.equal(v.verdict, "merge");
  assert.deepEqual(v.noLoss, ["drop-watcher"]);
});

test("团队更好且消融有损失 ⇒ retain", () => {
  const v = evaluateVerdict({
    arms: [
      arm("control", R({ failureRate: 0.2 })),
      arm("team", R({ failureRate: 0.1 })),
      arm("ablation", R({ failureRate: 0.35 }), { ref: "drop-decider" }),
    ],
  });
  assert.equal(v.verdict, "retain");
});

test("团队不优且消融无损失 ⇒ retire（多岗无益）", () => {
  const v = evaluateVerdict({
    arms: [
      arm("control", R({ failureRate: 0.2 })),
      arm("team", R({ failureRate: 0.2 })),
      arm("ablation", R({ failureRate: 0.2 }), { ref: "drop-all" }),
    ],
  });
  assert.equal(v.verdict, "retire");
});

test("消融臂读数缺失 ⇒ 不能说它没贡献（不判 retire/merge）", () => {
  const v = evaluateVerdict({
    arms: [
      arm("control", R({ failureRate: 0.2 })),
      arm("team", R({ failureRate: 0.2 })),
      arm("ablation", R({ failureRate: null }), { ref: "unmeasured" }),
    ],
  });
  assert.equal(v.verdict, "merge"); // 不是 retire：缺证据不构成「没贡献」
});

test("没有消融臂也能 retain，但必须如实说合并这一维无证据", () => {
  const v = evaluateVerdict({ arms: [arm("control", R({ failureRate: 0.2 })), arm("team", R({ failureRate: 0.1 }))] });
  assert.equal(v.verdict, "retain");
  assert.ok(v.missing.some((m) => m.includes("消融")));
});

test("裁决闭集：任何输入都只会产出五值之一", () => {
  const cases = [
    [],
    [arm("team", R())],
    [arm("control", R()), arm("team", R())],
    [arm("control", R()), arm("team", R()), arm("ablation", R(), { ref: "x" })],
  ];
  for (const arms of cases) assert.ok(VERDICTS.includes(evaluateVerdict({ arms }).verdict));
});

test("retire 不可新装，其余可（interactive publish 面读这条）", () => {
  assert.equal(isInstallable("retire"), false);
  assert.equal(isInstallable("retain"), true);
  assert.equal(isInstallable("inconclusive"), true);
});

test("判据分栏：确定性与模型判据不合并成一个总分", () => {
  const s = splitCriteria({ turns: 5, failureRate: 0.2, judgedAssertions: 3, judgedPassed: 2 });
  assert.equal(s.deterministic.failureRate, 0.2);
  assert.equal(s.judged.passed, 2);
  assert.equal(Object.hasOwn(s, "score"), false);
});

test("预算归一化：缺项 / 非正数 ⇒ null（不许猜一个默认）", () => {
  assert.equal(normalizeBudget(null), null);
  assert.equal(normalizeBudget({ turnsPerDay: 0, tokensPerTurn: 1 }), null);
  assert.deepEqual(normalizeBudget(budget), { turnsPerDay: 3, tokensPerTurn: 60000, maxTokens: 180000 });
});

test("可比性：两条臂但无对照 ⇒ 不合规", () => {
  const c = comparability([arm("team", R()), arm("ablation", R(), { ref: "x" })]);
  assert.equal(c.ok, false);
  assert.ok(c.problems.includes("no-control-arm"));
});

test("预算违约按 token 或 turns 任一超限都算", () => {
  assert.equal(budgetViolation(arm("team", R(), { observed: { tokens: 180001, turns: 1 } })).state, "violated");
  assert.equal(budgetViolation(arm("team", R(), { observed: { tokens: 1, turns: 4 } })).state, "violated");
  assert.equal(budgetViolation(arm("team", R())).state, "within");
});
