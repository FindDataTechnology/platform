#!/usr/bin/env node
// ── Sellability gate tests (add-blueprint-studio task 4.2) ──────────────────
//
// 可售态闸的决策树钉住：收费上架必须带 _casting + 绿报告；免费上架不拦；
// 免费模板无报告记 note；非集群模板跳过；断言的 code 字段由发布门原样返回。
//   node --test scripts/test-pack-sellability-gate.mjs

import assert from "node:assert/strict";
import { sellabilityGate, TRIAL_GATE_CODES } from "../gateway/pack-sellability-gate.js";
import { test } from "node:test";

test("4.2 收费集群模板缺 _casting → 400，代码 missingCasting", () => {
  const result = sellabilityGate({ name: "政策盯哨", fleet: { name: "x", members: [] } }, { pricing: { priceUsd: 9, kind: "once" } });
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, TRIAL_GATE_CODES.missingCasting);
  assert.match(result.errors[0].error, /casting provenance/);
});

test("4.2 有铸造但无试跑报告 → 400 missingTrial", () => {
  const result = sellabilityGate(
    { name: "政策盯哨", fleet: { name: "x", members: [] }, _casting: { source: "fleet-blueprint-studio", version: 1, approvedBy: "a@x", approvedAt: "2026-10-28T00:00:00Z" } },
    { pricing: { priceUsd: 9, kind: "once" } },
  );
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, TRIAL_GATE_CODES.missingTrial);
  assert.match(result.errors[0].error, /green trial report/);
});

test("4.2 有铸造有报告但不绿 → 400 trialNotGreen，指名失败断言", () => {
  const result = sellabilityGate(
    {
      name: "政策盯哨",
      fleet: { name: "x", members: [] },
      _casting: {
        source: "fleet-blueprint-studio",
        version: 1,
        approvedBy: "a@x",
        approvedAt: "2026-10-28T00:00:00Z",
        trialReport: { green: false, assertions: [{ id: "a1", pass: false }, { id: "a2", pass: true }] },
      },
    },
    { pricing: { priceUsd: 9, kind: "once" } },
  );
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, TRIAL_GATE_CODES.trialNotGreen);
  assert.match(result.errors[0].error, /a1/);
});

test("4.2 收费+铸造+绿报告 → 零错误放行", () => {
  const result = sellabilityGate(
    {
      name: "政策盯哨",
      fleet: { name: "x", members: [] },
      _casting: {
        source: "fleet-blueprint-studio",
        version: 1,
        approvedBy: "a@x",
        approvedAt: "2026-10-28T00:00:00Z",
        trialReport: { green: true, assertions: [{ id: "a1", pass: true }] },
      },
    },
    { pricing: { priceUsd: 9, kind: "once" } },
  );
  assert.equal(result.errors.length, 0);
});

test("4.2 免费上架（无 pricing）不拦，无报告只记 note", () => {
  const result = sellabilityGate(
    {
      name: "政策盯哨",
      fleet: { name: "x", members: [] },
      _casting: {
        source: "fleet-blueprint-studio",
        version: 1,
        approvedBy: "a@x",
        approvedAt: "2026-10-28T00:00:00Z",
        trialReport: { green: true, assertions: [{ id: "a1", pass: true }] },
      },
    },
    { pricing: null },
  );
  assert.equal(result.errors.length, 0);
  // 有绿报告的免费模板不触发 note。
  assert.equal(result.notes.length, 0);

  const freeNoReport = sellabilityGate(
    { name: "免费模板", fleet: { name: "x", members: [] } },
    { pricing: null },
  );
  assert.equal(freeNoReport.errors.length, 0);
  assert.equal(freeNoReport.notes.length, 1);
  assert.match(freeNoReport.notes[0], /free template publish without a green trial report/);
});

test("4.2 非集群模板（无 fleet 段）跳过可售闸", () => {
  const result = sellabilityGate({ name: "普通技能包", skills: [] }, { pricing: { priceUsd: 5, kind: "once" } });
  assert.equal(result.errors.length, 0);
  assert.equal(result.notes.length, 0);
});

test("4.2+ 双钥匙：模型断言未全 pass → llmNotPass；未签字 → signoffMissing；齐了放行", () => {
  const base = {
    name: "政策盯哨",
    fleet: { name: "x", members: [] },
    _casting: {
      source: "fleet-blueprint-studio",
      version: 1,
      approvedBy: "a@x",
      approvedAt: "2026-10-28T00:00:00Z",
    },
  };
  const pricing = { priceUsd: 9, kind: "once" };

  // 绿但模型断言有一条 fail → llmNotPass
  const notPass = sellabilityGate(
    { ...base, _casting: { ...base._casting, trialReport: { green: true, ranAt: 1, judged: [{ id: "sem", verdict: "fail", pass: false }], signoff: { by: "a@x", at: "x", reportRanAt: 1 } } } },
    { pricing },
  );
  assert.equal(notPass.errors.length, 1);
  assert.equal(notPass.errors[0].code, TRIAL_GATE_CODES.llmNotPass);
  assert.match(notPass.errors[0].error, /sem=fail/);

  // 全 pass 但未签字 → signoffMissing
  const unsigned = sellabilityGate(
    { ...base, _casting: { ...base._casting, trialReport: { green: true, ranAt: 1, judged: [{ id: "sem", verdict: "pass", pass: true }] } } },
    { pricing },
  );
  assert.equal(unsigned.errors.length, 1);
  assert.equal(unsigned.errors[0].code, TRIAL_GATE_CODES.signoffMissing);

  // 签字但针对旧一轮（reportRanAt 不匹配）→ 同样缺签
  const stale = sellabilityGate(
    { ...base, _casting: { ...base._casting, trialReport: { green: true, ranAt: 2, judged: [{ id: "sem", verdict: "pass", pass: true }], signoff: { by: "a@x", at: "x", reportRanAt: 1 } } } },
    { pricing },
  );
  assert.equal(stale.errors[0].code, TRIAL_GATE_CODES.signoffMissing);

  // 三件齐 → 放行
  const ok = sellabilityGate(
    { ...base, _casting: { ...base._casting, trialReport: { green: true, ranAt: 1, judged: [{ id: "sem", verdict: "pass", pass: true }], signoff: { by: "a@x", at: "x", reportRanAt: 1 } } } },
    { pricing },
  );
  assert.equal(ok.errors.length, 0);
});

test("4.2 后兼容：无 judged 数组的旧报告（纯机器绿）仍只看 green", () => {
  const legacy = sellabilityGate(
    {
      name: "旧包",
      fleet: { name: "x", members: [] },
      _casting: { source: "fleet-blueprint-studio", version: 1, approvedBy: "a@x", approvedAt: "x", trialReport: { green: true, ranAt: 1 } },
    },
    { pricing: { priceUsd: 9, kind: "once" } },
  );
  assert.equal(legacy.errors.length, 0);
});
