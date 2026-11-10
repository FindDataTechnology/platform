#!/usr/bin/env node
// ── Skill-eval guidance ground-truth tests (fix-skill-eval-guidance-groundtruth) ──
//
// runSkillEval with a faithful mock: executor answers are DISTINCT per arm (the
// mock marks each transcript by which guidance the arm's system prompt carried),
// and the mock judge reads the blind judge prompt to find which 甲乙丙 label
// carries the candidate's transcript — exactly what a blind evaluator does.
//   node --test scripts/test-skill-eval-groundtruth.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { runSkillEval } from "../server/skill-eval.js";

const LANE = { baseUrl: "http://judge.test/v1", model: "test-judge", apiKey: "k" };

const CAND_BODY = "# 客户反馈分诊 v2（政策）\n- 72h 自动升级：同一主体 72h 内多条合并附次数，超期未解自动升一级。\n- SLA：P0=1h / P1=4h / P2=1 个工作日。";
const OLD_BODY = "# 客户反馈分诊 v1\n- SLA：P0=1h / P1=4h / P2=1 个工作日。";
const TASK = "分诊 3 条反馈：①「付款后订单不显示」②「希望导出」③「怎么改发票抬头」。";

// Mock judge: pick which 甲乙丙 answer carries the marker, return that label
// (or a forced override for gate-branch tests).
function makeMock({ forceBest = null } = {}) {
  const captured = [];
  const fetchImpl = async (_url, opts = {}) => {
    const body = JSON.parse(opts.body);
    const system = body.messages[0].content;
    const user = body.messages[1].content;
    const isJudge = system.includes("strict, anonymous evaluator");
    let content;
    if (isJudge) {
      let best = forceBest;
      if (!best) {
        // Blind-judge simulation: the candidate arm's transcript carries the
        // candidate-only marker (its guidance text); find its 甲乙丙 label.
        const candLabel = ["甲", "乙", "丙"].find((l) => user.includes(`【回答${l}】\n转写(candidate)`) || user.includes(`【回答${l}】\n转写(candidate）`));
        best = candLabel ?? "tie";
      }
      content = JSON.stringify({ best, reasoning: "mock" });
    } else {
      // Executor: mark the transcript by which guidance the system prompt carried.
      const skill = system.includes("skill guidance available")
        ? (system.includes("72h 自动升级") ? "candidate" : system.includes("客户反馈分诊 v1") ? "old" : "none")
        : "none";
      content = skill === "none" ? "转写(none)" : `转写(${skill})`;
    }
    captured.push({ isJudge, user });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      text: async () => content,
    };
  };
  return { fetchImpl, captured };
}

test("supersedes eval: judge prompt carries both guidance docs, blind-labeled and independent", async () => {
  const { fetchImpl, captured } = makeMock();
  const report = await runSkillEval({
    candidate: { body: CAND_BODY, supersedes: "old-skill" },
    scenarioPrompt: TASK,
    lane: LANE,
    oldSkillBody: OLD_BODY,
    fetchImpl,
  });
  assert.equal(report.passed, true, "mock blind-judge picks the candidate arm by its transcript");
  const judge = captured.find((c) => c.isJudge);
  assert.ok(judge, "judge call captured");
  // Both doc sections present with the blind doc labels (never 甲乙丙 glyphs).
  assert.ok(judge.user.includes("【指导文档一】"), "doc section one");
  assert.ok(judge.user.includes("【指导文档二】"), "doc section two");
  assert.ok(judge.user.includes("72h 自动升级"), "candidate doc body present");
  assert.ok(judge.user.includes("客户反馈分诊 v1"), "old doc body present");
  assert.ok(!/【指导文档[甲乙丙]】/.test(judge.user), "doc labels never use answer glyphs");
  // Answer labels intact, doc labels disjoint from answer labels.
  assert.ok(judge.user.includes("【回答甲】"), "answer labels intact");
  // Grounding rules: required elements.
  assert.ok(judge.user.includes("视为有据"), "grounded rule");
  assert.ok(judge.user.includes("视为无据（准确性存疑）"), "unfounded rule");
  assert.ok(judge.user.includes("对称适用于全部回答"), "symmetric across arms");
  assert.ok(judge.user.includes("与所引文档的长度无关"), "anti-length-bias clause");
});

test("two-arm eval (no supersedes): single guidance doc section, no numbered doc label", async () => {
  const { fetchImpl, captured } = makeMock({ forceBest: "tie" });
  const report = await runSkillEval({
    candidate: { body: CAND_BODY },
    scenarioPrompt: TASK,
    lane: LANE,
    fetchImpl,
  });
  assert.equal(report.passed, true, "tie passes (不劣于)");
  const judge = captured.find((c) => c.isJudge);
  assert.ok(judge, "judge call captured");
  assert.ok(judge.user.includes("【指导文档】"), "single doc section");
  assert.ok(!judge.user.includes("【指导文档一】"), "no numbered doc label in two-arm shape");
  assert.ok(judge.user.includes("72h 自动升级"), "candidate body present");
  assert.ok(judge.user.includes("对称适用于全部回答"), "rules still present");
});

test("overlong guidance doc is clipped in the judge prompt", async () => {
  const { fetchImpl, captured } = makeMock({ forceBest: "tie" });
  const longBody = "x".repeat(20_000);
  await runSkillEval({
    candidate: { body: longBody, supersedes: "old-skill" },
    scenarioPrompt: TASK,
    lane: LANE,
    oldSkillBody: OLD_BODY,
    fetchImpl,
  });
  const judge = captured.find((c) => c.isJudge);
  assert.ok(judge, "judge call captured");
  assert.ok(judge.user.includes("…[clipped]"), "long doc clipped");
  assert.ok(judge.user.length < 25_000, "judge prompt bounded");
});

test("gate semantics unchanged across all four verdict branches", async () => {
  const cases = [
    [{ best: "candidate", reasoning: "x" }, true, "candidate ranked best"],
    [{ best: "tie", reasoning: "x" }, true, "tie"],
    [{ best: "old", reasoning: "x" }, false, "old skill ranked best"],
    [{ best: "control", reasoning: "x" }, false, "control ranked best"],
  ];
  for (const [v, expectPass, reasonPrefix] of cases) {
    // forceBest: return the raw verdict.best verbatim (unmapped labels → the
    // gate's unmappable branch is separately covered by the mock default).
    const { fetchImpl } = makeMock({ forceBest: v.best === "candidate" ? null : undefined });
    // For candidate we use the blind simulation; for the others the judge
    // returns a non-label token, exercising the unmappable branch — so instead
    // drive the label honestly: find the label of the arm the verdict names.
    const { fetchImpl: f2 } = (() => ({ fetchImpl }))();
    void f2;
    const report = await runSkillEval({
      candidate: { body: CAND_BODY, supersedes: "old-skill" },
      scenarioPrompt: TASK,
      lane: LANE,
      oldSkillBody: OLD_BODY,
      fetchImpl: makeVerdictAwareMock(v.best),
    });
    assert.equal(report.passed, expectPass, `verdict ${v.best}`);
    assert.ok(report.reason.startsWith(reasonPrefix.split(" — ")[0]), `reason for ${v.best}: ${report.reason}`);
  }
});

// A verdict-aware mock: the judge returns the 甲乙丙 label of the arm named by
// the verdict (control/old/candidate identified by transcript markers).
function makeVerdictAwareMock(namedArm) {
  const marker = { control: "转写(none)", old: "转写(old)", candidate: "转写(candidate)" }[namedArm];
  const fetchImpl = async (_url, opts = {}) => {
    const body = JSON.parse(opts.body);
    const system = body.messages[0].content;
    const user = body.messages[1].content;
    const isJudge = system.includes("strict, anonymous evaluator");
    let content;
    if (isJudge) {
      const label = ["甲", "乙", "丙"].find((l) => user.includes(`【回答${l}】\n${marker}`));
      content = JSON.stringify({ best: label ?? "tie", reasoning: "mock" });
    } else {
      const skill = system.includes("skill guidance available")
        ? (system.includes("72h 自动升级") ? "candidate" : system.includes("客户反馈分诊 v1") ? "old" : "none")
        : "none";
      content = skill === "none" ? "转写(none)" : `转写(${skill})`;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }], usage: {} }),
      text: async () => content,
    };
  };
  return fetchImpl;
}
