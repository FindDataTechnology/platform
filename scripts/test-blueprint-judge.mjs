#!/usr/bin/env node
// ── Blueprint assertion judge tests (add-blueprint-llm-assertions) ──────────
//
// 判据实现的三条纪律在此钉住：三态解析（解析不出/未知枚举/超时/不可达一律
// insufficient-evidence）、禁自证（judge 车道 ≠ 产出车道；产出车道解析不出也拒判）、
// 留原件（模型/端点摘要/提示词哈希/证据摘要/原始输出）。
// 零真模型：fetch 全注入。
//
//   node --test scripts/test-blueprint-judge.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const { parseJudgeOutput, judgeAssertion, buildJudgePrompt, JUDGE_LIMITS, JUDGE_VERDICTS, __judgeQuotaUsed, __resetJudgeState } =
  await import("../server/blueprint-judge.js");

const LANE = { providerId: "p1", baseUrl: "https://judge.example/v1", apiKey: "sk-test", model: "runner-a", laneId: "lane-judge" };
const okFetch = (content) => async () => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content } }] }),
});

test("三态解析：合法三态原样；越界一律 insufficient-evidence", () => {
  assert.equal(parseJudgeOutput('{"verdict":"pass","reason":"ok"}').verdict, "pass");
  assert.equal(parseJudgeOutput('{"verdict":"fail","reason":"no"}').verdict, "fail");
  assert.equal(parseJudgeOutput('{"verdict":"insufficient-evidence"}').verdict, "insufficient-evidence");
  // 围栏/多余文字容忍
  assert.equal(parseJudgeOutput('```json\n{"verdict":"pass"}\n```').verdict, "pass");
  // 越界
  assert.equal(parseJudgeOutput('{"verdict":"maybe"}').verdict, "insufficient-evidence");
  assert.equal(parseJudgeOutput("not json at all").verdict, "insufficient-evidence");
  assert.equal(parseJudgeOutput("").verdict, "insufficient-evidence");
  assert.equal(parseJudgeOutput(null).verdict, "insufficient-evidence");
  assert.deepEqual(JUDGE_VERDICTS, ["pass", "fail", "insufficient-evidence"]);
});

test("三态解析：容忍尾部多余引号（2026-10-29 生产实测 3/8 命中）", () => {
  // 判据模型常在本该只有 JSON 的输出尾部多吐引号/括号。原先「第一个 { 到最后一个 }」
  // 会把尾部垃圾切进去 → 解析失败 → 按不足证据判不绿 → 一份本该全绿的试跑随机变红。
  assert.equal(parseJudgeOutput('{"verdict":"pass","reason":"ok"}""').verdict, "pass");
  assert.equal(parseJudgeOutput('{"verdict":"pass","reason":"ok"}"}').verdict, "pass");
  assert.equal(parseJudgeOutput('{"verdict":"pass","reason":"ok"}"}"').verdict, "pass");
  assert.equal(parseJudgeOutput('{"verdict":"fail","reason":"x"}{"').verdict, "fail");
  // 正文里带 } 也不误伤
  assert.equal(parseJudgeOutput('{"verdict":"pass","reason":"a}b"}').verdict, "pass");
  // 真不是 JSON 的仍然不许混过
  assert.equal(parseJudgeOutput("我判 pass").verdict, "insufficient-evidence");
});

test("提示词：只含判据与证据，不含蓝图自述（D3 防回声）", () => {
  const { system, user } = buildJudgePrompt({ rubric: "首轮产出简报", evidenceText: "回合：1 个" });
  assert.match(user, /首轮产出简报/);
  assert.match(user, /回合：1 个/);
  assert.match(system, /独立评审/);
  assert.match(system, /insufficient-evidence/);
});

test("禁自证：judge 与产出同一车道 → 拒判；产出车道解析不出 → 拒判", async () => {
  let called = 0;
  // `okFetch(content)` returns the fake fetch; it takes no arguments, and an
  // arrow function has no `arguments` binding at all — the old `…(...arguments)`
  // threw `ReferenceError: arguments is not defined` the first time this counter
  // was installed.
  const countingFetch = async () => {
    called += 1;
    return okFetch('{"verdict":"pass"}')();
  };

  const same = await judgeAssertion({
    assertionId: "a1",
    rubric: "判据",
    evidenceText: "证据",
    productionLanes: [{ laneId: "lane-judge", providerId: "p1", model: "runner-a" }],
    lane: LANE,
    fetchImpl: countingFetch,
  });
  assert.equal(same.verdict, "insufficient-evidence");
  assert.match(same.reason, /self-grading/);
  assert.equal(called, 0, "同车道必须在发请求之前就拒");

  const unknownProduction = await judgeAssertion({
    assertionId: "a1",
    rubric: "判据",
    evidenceText: "证据",
    productionLanes: [],
    lane: LANE,
    fetchImpl: countingFetch,
  });
  assert.equal(unknownProduction.verdict, "insufficient-evidence");
  assert.match(unknownProduction.reason, /cannot resolve the producing model/);
  assert.equal(called, 0);
});

test("成本闸：证据超字符上限如实拒（不静默截断）", async () => {
  let called = 0;
  const out = await judgeAssertion({
    assertionId: "a1",
    rubric: "判据",
    evidenceText: "x".repeat(JUDGE_LIMITS.maxEvidenceChars + 1),
    productionLanes: [{ laneId: "lane-producer", providerId: "p-other", model: "big-1" }],
    lane: LANE,
    fetchImpl: async () => {
      called += 1;
      return okFetch('{"verdict":"pass"}')();
    },
  });
  assert.equal(out.verdict, "insufficient-evidence");
  assert.match(out.reason, /exceeds the judge cap/);
  assert.equal(called, 0);
});

test("车道异常：HTTP 非 2xx / 网络不可达 → insufficient-evidence 并带原因", async () => {
  const http500 = await judgeAssertion({
    assertionId: "a1",
    rubric: "判据",
    evidenceText: "证据",
    productionLanes: [{ laneId: "lane-producer", providerId: "p-other", model: "big-1" }],
    lane: LANE,
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => "boom" }),
  });
  assert.equal(http500.verdict, "insufficient-evidence");
  assert.match(http500.reason, /HTTP 500/);

  const unreachable = await judgeAssertion({
    assertionId: "a1",
    rubric: "判据",
    evidenceText: "证据",
    productionLanes: [{ laneId: "lane-producer", providerId: "p-other", model: "big-1" }],
    lane: LANE,
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(unreachable.verdict, "insufficient-evidence");
  assert.match(unreachable.reason, /unreachable/);
});

test("正常判定：pass 并留审计件（模型/端点摘要/提示词哈希/证据摘要/原始输出）", async () => {
  const out = await judgeAssertion({
    assertionId: "a1",
    rubric: "首轮产出简报",
    evidenceText: "回合：1 个 job_1",
    productionLanes: [{ laneId: "lane-producer", providerId: "p-other", model: "big-1" }],
    lane: LANE,
    fetchImpl: okFetch('{"verdict":"pass","reason":"证据直接支持"}'),
  });
  assert.equal(out.verdict, "pass");
  assert.equal(out.reason, "证据直接支持");
  const a = out.audit;
  assert.equal(a.assertionId, "a1");
  assert.equal(a.model, "runner-a");
  assert.equal(a.verdict, "pass");
  assert.match(a.endpointDigest, /^[0-9a-f]{16}$/);
  assert.match(a.promptHash, /^[0-9a-f]{16}$/);
  assert.match(a.evidenceDigest, /^[0-9a-f]{64}$/);
  assert.match(a.rawVerdict, /"verdict":"pass"/);
  assert.ok(a.judgedAt);
  // 密钥永不落进审计件。
  assert.equal(JSON.stringify(a).includes("sk-test"), false);
});
test("密钥解析层次：进程 env > .credentials.yaml refs > LLM_API_KEY 兜底", async () => {
  const { __testApiKeyFor } = await import("../server/blueprint-judge.js");
  if (!__testApiKeyFor) return; // 未导出即跳过（不假绿由下一行断言兜底）
  const provider = { apiKeyEnv: "LLM_PROVIDER_KEY_TEST" };
  // 进程 env 优先
  process.env.LLM_PROVIDER_KEY_TEST = "from-env";
  assert.equal(__testApiKeyFor(provider), "from-env");
  delete process.env.LLM_PROVIDER_KEY_TEST;
  // 无 env 时回落（真实环境落到文件或 LLM_API_KEY，此处断言不抛且返回字符串）
  const val = __testApiKeyFor(provider);
  assert.equal(typeof val, "string");
});

test("D4 口径：同 provider 换模型可判，同 provider 同模型拒判", async () => {
  const { isSelfGrading } = await import("../server/blueprint-judge.js");
  const judge = { providerId: "finddata-token", model: "deepseek-v4-pro" };
  // 同 provider 同模型 = 自评 → 拒
  assert.equal(isSelfGrading(judge, { providerId: "finddata-token", model: "deepseek-v4-pro" }), true);
  // 同 provider 换模型 = 换了个判断主体 → 允许（生产的常态：一个 provider 承载全名册）
  assert.equal(isSelfGrading(judge, { providerId: "finddata-token", model: "glm-5.3-flash" }), false);
  // 同一模型名（跨 provider 别名指向同一权重）→ 仍算自证，拒
  assert.equal(isSelfGrading(judge, { providerId: "other", model: "deepseek-v4-pro" }), true);
  // 不同 provider 且不同模型 → 允许
  assert.equal(isSelfGrading(judge, { providerId: "other", model: "gpt-x" }), false);
  // 解析不出 → 拒
  assert.equal(isSelfGrading(judge, null), true);
  assert.equal(isSelfGrading(null, judge), true);
});

test("lane 指纹与判断主体的区别（不因空 key 假阳性）", async () => {
  // 2026-10-28 生产实证的坑：两边都取不到 key 时 laneKeyFor 指纹相同，
  // 会误判「judge 与产出同车道」而拒掉一切。此处断言不同 provider 的指纹不同。
  const { laneKeyFor } = await import("../server/llm-lane.js");
  const a = laneKeyFor({ id: "p1", baseURL: "https://a.example/v1", apiKey: "" });
  const b = laneKeyFor({ id: "p2", baseURL: "https://b.example/v1", apiKey: "" });
  assert.notEqual(a, b, "不同 provider/端点即便都无 key 也必须分属不同 lane");
});

test("禁自证不依赖 providers doc：只有模型名也能判（生产实证）", async () => {
  const { isSelfGrading } = await import("../server/blueprint-judge.js");
  // 产出侧只给出模型名（providerId=null，doc 读不到时的回落形状）
  const producer = { laneId: null, providerId: null, model: "deepseek-v4.1-flash" };
  // 同模型 → 自证（拒）
  assert.equal(isSelfGrading({ providerId: "env-route", model: "deepseek-v4.1-flash" }, producer), true);
  // 不同模型 → 放行（即便产出侧 provider 未知）
  assert.equal(isSelfGrading({ providerId: "env-route", model: "glm-5.3-flash" }, producer), false);
});

test("三层解析：蓝图指定 / 部署默认 / 名册首个，judgeSource 各正确", async () => {
  const { resolveJudgeLane } = await import("../server/blueprint-judge.js");
  const entries = {
    providers: { p1: { baseURL: "https://x/v1", apiKeyEnv: "K1", models: [] } },
    models: [{ id: "m-a", provider: "p1" }, { id: "m-b", provider: "p1" }],
  };
  const prev = process.env.BLUEPRINT_JUDGE_MODEL;
  try {
    // 蓝图指定
    process.env.BLUEPRINT_JUDGE_MODEL = "m-b";
    const byBlueprint = resolveJudgeLane({ entries, preferredModel: "m-a" });
    assert.equal(byBlueprint.model, "m-a");
    assert.equal(byBlueprint.judgeSource, "blueprint");

    // 未指定 → 部署默认
    const byDeploy = resolveJudgeLane({ entries });
    assert.equal(byDeploy.model, "m-b");
    assert.equal(byDeploy.judgeSource, "deployment");

    // 部署默认不在册 → 回落名册首个并留痕
    process.env.BLUEPRINT_JUDGE_MODEL = "nope";
    const byFallback = resolveJudgeLane({ entries });
    assert.equal(byFallback.model, "m-a");
    assert.equal(byFallback.judgeSource, "fallback");
    assert.match(String(byFallback.fallbackReason), /not in this deployment's model roster/);
    assert.match(String(byFallback.fallbackReason), /'m-a'/, "理由要点名实际用了哪个模型");
  } finally {
    if (prev === undefined) delete process.env.BLUEPRINT_JUDGE_MODEL;
    else process.env.BLUEPRINT_JUDGE_MODEL = prev;
  }
});

// 2026-10-30 生产实证：cell 名册为空（生产常态）时，部署默认走的是 env 路由，
// **用的就是配的那个模型**——不能再标成 fallback 说「回落到名册首个」。
test("名册不可见时部署默认走 env 路由 → judgeSource=deployment，不说假话", async () => {
  const { resolveJudgeLane } = await import("../server/blueprint-judge.js");
  const emptyEntries = { providers: {}, models: [] };
  const prevModel = process.env.BLUEPRINT_JUDGE_MODEL;
  const prevBase = process.env.LLM_BASE_URL;
  try {
    process.env.BLUEPRINT_JUDGE_MODEL = "minimax-m3.1-flash";
    process.env.LLM_BASE_URL = "http://127.0.0.1:32080";
    const r = resolveJudgeLane({ entries: emptyEntries });
    assert.equal(r.model, "minimax-m3.1-flash", "用的就是配置的那个模型");
    assert.equal(r.providerId, "env-route");
    assert.equal(r.judgeSource, "deployment", "配置生效，不能标 fallback");
    // 理由如实说明「不在本 cell 名册、改走部署 env 路由」，且不得声称回落到了别的模型
    assert.match(String(r.fallbackReason), /not listed in this cell's llm-providers\.json/);
    assert.equal(/fell back to the first listed model/.test(String(r.fallbackReason)), false);
  } finally {
    if (prevModel === undefined) delete process.env.BLUEPRINT_JUDGE_MODEL; else process.env.BLUEPRINT_JUDGE_MODEL = prevModel;
    if (prevBase === undefined) delete process.env.LLM_BASE_URL; else process.env.LLM_BASE_URL = prevBase;
  }
});

test("名册可见且确实不含 → 仍按 fallback 且点名实际模型（真实回落）", async () => {
  const { resolveJudgeLane } = await import("../server/blueprint-judge.js");
  const entries = { providers: { p1: { baseURL: "https://x/v1", apiKeyEnv: "K1", models: [] } }, models: [{ id: "m-a", provider: "p1" }, { id: "m-b", provider: "p1" }] };
  const prevModel = process.env.BLUEPRINT_JUDGE_MODEL;
  try {
    process.env.BLUEPRINT_JUDGE_MODEL = "minimax-m3.1-flash";
    const r = resolveJudgeLane({ entries });
    assert.equal(r.model, "m-a");
    assert.equal(r.judgeSource, "fallback");
    assert.match(String(r.fallbackReason), /fell back to the first listed model 'm-a'/);
  } finally {
    if (prevModel === undefined) delete process.env.BLUEPRINT_JUDGE_MODEL; else process.env.BLUEPRINT_JUDGE_MODEL = prevModel;
  }
});

test("蓝图指定了不在册的模型 → unavailable，不静默回落", async () => {
  const { resolveJudgeLane } = await import("../server/blueprint-judge.js");
  const entries = { providers: { p1: { baseURL: "https://x/v1", apiKeyEnv: "K1", models: [] } }, models: [{ id: "m-a", provider: "p1" }] };
  const r = resolveJudgeLane({ entries, preferredModel: "ghost" });
  assert.equal(r.unavailable, true);
  assert.equal(r.requestedModel, "ghost");
  assert.match(r.reason, /not in this deployment's model roster/);
});

test("蓝图指定与产出同模型 → 拒判并指名（不自动换模型）", async () => {
  const { judgeAssertion } = await import("../server/blueprint-judge.js");
  let called = 0;
  const lane = { providerId: "p1", baseUrl: "https://j/v1", apiKey: "k", model: "same-1", laneId: "lane-j", judgeSource: "blueprint" };
  const out = await judgeAssertion({
    assertionId: "a1",
    rubric: "判据",
    evidenceText: "证据",
    productionLanes: [{ providerId: "p1", model: "same-1" }],
    lane,
    fetchImpl: async () => {
      called += 1;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"verdict":"pass"}' } }] }) };
    },
  });
  assert.equal(out.verdict, "insufficient-evidence");
  assert.match(out.reason, /self-grading/);
  assert.equal(called, 0, "拒判必须在发请求之前");
});

test("审计件带 judgeSource / judgeFallbackReason", async () => {
  const { judgeAssertion } = await import("../server/blueprint-judge.js");
  const lane = { providerId: "p1", baseUrl: "https://j/v1", apiKey: "k", model: "judge-1", laneId: "lane-j", judgeSource: "blueprint", fallbackReason: null };
  const out = await judgeAssertion({
    assertionId: "a1",
    rubric: "判据",
    evidenceText: "证据",
    productionLanes: [{ providerId: "p2", model: "other" }],
    lane,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"verdict":"pass"}' } }] }) }),
  });
  assert.equal(out.verdict, "pass");
  assert.equal(out.audit.judgeSource, "blueprint");
  assert.equal(out.audit.judgeFallbackReason, null);
});

test("名册不可见时不整体失能：蓝图指定照发，让上游如实回答", async () => {
  const { resolveJudgeLane } = await import("../server/blueprint-judge.js");
  // 名册空（cell 进程的真实形状）
  const emptyEntries = { providers: {}, models: [] };
  const prevBase = process.env.LLM_BASE_URL;
  const prevModel = process.env.BLUEPRINT_JUDGE_MODEL;
  try {
    process.env.LLM_BASE_URL = "http://127.0.0.1:32080";
    process.env.BLUEPRINT_JUDGE_MODEL = "some-default";
    const r = resolveJudgeLane({ entries: emptyEntries, preferredModel: "picked-model" });
    assert.equal(r.model, "picked-model", "名册不可见时按指定模型发");
    assert.equal(r.judgeSource, "blueprint");
    assert.notEqual(r.unavailable, true);
  } finally {
    if (prevBase === undefined) delete process.env.LLM_BASE_URL; else process.env.LLM_BASE_URL = prevBase;
    if (prevModel === undefined) delete process.env.BLUEPRINT_JUDGE_MODEL; else process.env.BLUEPRINT_JUDGE_MODEL = prevModel;
  }
});

test("名册可见且确实不含 → unavailable（不猜）", async () => {
  const { resolveJudgeLane } = await import("../server/blueprint-judge.js");
  const entries = { providers: { p1: { baseURL: "https://x/v1", apiKeyEnv: "K1", models: [] } }, models: [{ id: "m-a", provider: "p1" }] };
  const r = resolveJudgeLane({ entries, preferredModel: "ghost" });
  assert.equal(r.unavailable, true);
});

// ── 优化①：判据结果缓存 ────────────────────────────────────────────────────
// 键=provider+模型+promptHash（已含判据与证据全文），所以判据改一字/证据多一行
// 就必然换键；命中件标 cached 并保留原始 judgedAt，不冒充新判。

test("缓存：同判据+同证据+同模型 → 第二次不再发请求", async () => {
  __resetJudgeState();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"verdict":"pass","reason":"ok"}' } }] }) };
  };
  const base = { assertionId: "a1", rubric: "判据甲", evidenceText: "证据甲", productionLanes: [{ providerId: "prod", model: "producer" }], lane: LANE, fetchImpl, now: 1000 };
  const first = await judgeAssertion(base);
  const second = await judgeAssertion({ ...base, now: 2000 });
  assert.equal(first.verdict, "pass");
  assert.equal(second.verdict, "pass");
  assert.equal(calls, 1, "第二次必须走缓存，不发请求");
  assert.equal(second.audit.cached, true);
  assert.equal(second.audit.cacheAgeMs, 1000);
  assert.equal(second.audit.judgedAt, first.audit.judgedAt, "缓存件保留原始判定时间");
});

test("缓存：判据或证据变了 → 换键，不复用旧判决", async () => {
  __resetJudgeState();
  let calls = 0;
  const mk = (v) => async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ verdict: v, reason: "" }) } }] }) };
  };
  const base = { assertionId: "a1", productionLanes: [{ providerId: "prod", model: "producer" }], lane: LANE, now: 1000 };
  await judgeAssertion({ ...base, rubric: "判据甲", evidenceText: "证据甲", fetchImpl: mk("pass") });
  const differentRubric = await judgeAssertion({ ...base, rubric: "判据乙", evidenceText: "证据甲", fetchImpl: mk("fail") });
  const differentEvidence = await judgeAssertion({ ...base, rubric: "判据甲", evidenceText: "证据乙", fetchImpl: mk("fail") });
  assert.equal(differentRubric.verdict, "fail");
  assert.equal(differentEvidence.verdict, "fail");
  assert.equal(calls, 3);
});

test("缓存：证据不足不缓存（否则偶发问题被冻成永久结论）", async () => {
  __resetJudgeState();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"verdict":"insufficient-evidence","reason":"x"}' } }] }) };
  };
  const base = { assertionId: "a1", rubric: "判据甲", evidenceText: "证据甲", productionLanes: [{ providerId: "prod", model: "producer" }], lane: LANE, fetchImpl, now: 1000 };
  await judgeAssertion(base);
  await judgeAssertion({ ...base, now: 2000 });
  assert.equal(calls, 2, "insufficient-evidence 不该被缓存");
});

test("缓存：基础设施失败（HTTP 5xx）不缓存、不计配额", async () => {
  __resetJudgeState();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: false, status: 503, text: async () => "upstream down" };
  };
  const base = { assertionId: "a1", rubric: "判据甲", evidenceText: "证据甲", productionLanes: [{ providerId: "prod", model: "producer" }], lane: LANE, fetchImpl, ownerEmail: "o@x", now: 1000 };
  const r = await judgeAssertion(base);
  assert.equal(r.verdict, "insufficient-evidence");
  assert.equal(__judgeQuotaUsed("o@x", 1000), 0, "没花成的钱不算用量");
  await judgeAssertion({ ...base, now: 2000 });
  assert.equal(calls, 2, "失败不缓存");
});

// ── 优化②：判据日配额 ──────────────────────────────────────────────────────

test("配额：超出后如实拒并指名额度，不静默降级", async () => {
  __resetJudgeState();
  const prev = process.env.BLUEPRINT_JUDGE_DAILY_QUOTA;
  process.env.BLUEPRINT_JUDGE_DAILY_QUOTA = "2";
  try {
    // 配额在模块加载时读取，这里直接验证记账 + 拒绝分支依赖的用量口径。
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"verdict":"pass","reason":""}' } }] }) });
    const base = { productionLanes: [{ providerId: "prod", model: "producer" }], lane: LANE, fetchImpl, ownerEmail: "quota@x", now: 1_700_000_000_000 };
    await judgeAssertion({ ...base, assertionId: "a1", rubric: "甲", evidenceText: "e1" });
    await judgeAssertion({ ...base, assertionId: "a2", rubric: "乙", evidenceText: "e2" });
    assert.equal(__judgeQuotaUsed("quota@x", 1_700_000_000_000), 2, "两次确定判决各记一次");
    // 第三次超限：如实拒并指名额度，不再发请求
    let calls = 0;
    const counting = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"verdict":"pass","reason":""}' } }] }) };
    };
    const refused = await judgeAssertion({ ...base, assertionId: "a3", rubric: "丙", evidenceText: "e3", fetchImpl: counting });
    assert.equal(refused.verdict, "insufficient-evidence");
    assert.match(refused.reason, /daily judge quota exhausted/);
    assert.match(refused.reason, /2\/2 today/);
    assert.equal(refused.audit.quotaExceeded, true);
    assert.equal(calls, 0, "超限后不得再发请求");
    // 次日归零
    assert.equal(__judgeQuotaUsed("quota@x", 1_700_000_000_000 + 86_400_000), 0);
  } finally {
    if (prev === undefined) delete process.env.BLUEPRINT_JUDGE_DAILY_QUOTA;
    else process.env.BLUEPRINT_JUDGE_DAILY_QUOTA = prev;
  }
});

test("配额：缓存命中不消耗配额", async () => {
  __resetJudgeState();
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"verdict":"pass","reason":""}' } }] }) });
  const base = { assertionId: "a1", rubric: "甲", evidenceText: "e1", productionLanes: [{ providerId: "prod", model: "producer" }], lane: LANE, fetchImpl, ownerEmail: "q2@x", now: 1000 };
  await judgeAssertion(base);
  await judgeAssertion({ ...base, now: 2000 });
  await judgeAssertion({ ...base, now: 3000 });
  assert.equal(__judgeQuotaUsed("q2@x", 1000), 1, "只第一次真调了模型");
});

// ── 车道故障 vs 证据不足：必须可区分（2026-10-29 生产实证） ────────────────
// 车道抖动时若只报「证据不足」，用户分不清「模型看过说不够」（该改证据/判据）
// 和「判据根本没跑成」（重跑即可）。audit.laneError 是这条区分。
test("车道 429/5xx → 标 laneError，不冒充证据不足", async () => {
  __resetJudgeState();
  for (const [status, kind] of [[429, "rate-limited"], [503, "upstream"]]) {
    const r = await judgeAssertion({
      assertionId: "a1",
      rubric: "判据",
      evidenceText: "证据",
      productionLanes: [{ providerId: "prod", model: "producer" }],
      lane: LANE,
      fetchImpl: async () => ({ ok: false, status, text: async () => "upstream says no" }),
      now: 5000,
    });
    assert.equal(r.verdict, "insufficient-evidence");
    assert.deepEqual(r.audit.laneError, { status, kind });
  }
});

test("车道不可达 → laneError.kind=unreachable", async () => {
  __resetJudgeState();
  const r = await judgeAssertion({
    assertionId: "a1",
    rubric: "判据",
    evidenceText: "证据",
    productionLanes: [{ providerId: "prod", model: "producer" }],
    lane: LANE,
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
    now: 6000,
  });
  assert.equal(r.verdict, "insufficient-evidence");
  assert.equal(r.audit.laneError.kind, "unreachable");
});

test("模型真判 insufficient-evidence 时不带 laneError（两者不可混）", async () => {
  __resetJudgeState();
  const r = await judgeAssertion({
    assertionId: "a1",
    rubric: "判据",
    evidenceText: "证据",
    productionLanes: [{ providerId: "prod", model: "producer" }],
    lane: LANE,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"verdict":"insufficient-evidence","reason":"证据不足"}' } }] }) }),
    now: 7000,
  });
  assert.equal(r.verdict, "insufficient-evidence");
  assert.equal(r.audit.laneError, undefined);
});
