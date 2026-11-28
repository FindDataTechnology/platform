// 单臂试跑判词（establish-agent-role-and-fitness-plane 8.4 / 8.5）。
//
// 核心是三件「客户面不许发生」的事：
//   · 没有对照却输出裁决
//   · 跑不起来被说成「这份包不好」
//   · 跑完了什么都没留下，却被判「像样」
//
// Run: node --test lib/fitness-single-arm.test.js

import assert from "node:assert/strict";
import { test } from "node:test";

const { judgeSingleArm, classifyFailure, assertionNoVerdict, HEALTH, OUTPUT } = await import("./fitness-single-arm.js");

test("缺凭据 ⇒ blocked + credentials，措辞是「你这里缺」而不是「包不好」", () => {
  const r = judgeSingleArm({ errors: ["401 Unauthorized: invalid token for fd-info"] });
  assert.equal(r.health, "blocked");
  assert.equal(r.reason, "credentials");
  assert.ok(r.message.includes("你这里缺凭据"));
  assert.ok(!/包.*不好|不成立/.test(r.message));
});

test("失败分类覆盖六类环境问题 + 装配问题，认不准就 unknown", () => {
  const cases = [
    ["ECONNREFUSED 10.0.0.1:443", "network"],
    ["429 rate limit exceeded", "quota"],
    ["502 Bad Gateway", "upstream"],
    ["422 invalid schema", "config"],
    ["no such preset: p-x", "assembly"],
    ["随便一段没有关键词的输出", "unknown"],
  ];
  for (const [text, want] of cases) assert.equal(classifyFailure(text), want, text);
});

test("一个回合都没起来 ⇒ assembly（装上了但没可跑的任务）", () => {
  const r = judgeSingleArm({ rounds: [] });
  assert.equal(r.health, "blocked");
  assert.equal(r.reason, "assembly");
});

test("全部回合失败 ⇒ blocked 且按错误归类", () => {
  const r = judgeSingleArm({ rounds: [{ status: "failed", error: "ETIMEDOUT" }, { status: "failed", error: "ETIMEDOUT" }] });
  assert.equal(r.health, "blocked");
  assert.equal(r.reason, "network");
});

test("成功回合 + 有报数/产物 ⇒ runs + decent", () => {
  const r = judgeSingleArm({ rounds: [{ status: "ok", reportLanded: true }] });
  assert.equal(r.health, "runs");
  assert.equal(r.output, "decent");
  const r2 = judgeSingleArm({ rounds: [{ status: "ok", artifactRefs: ["board:1"] }] });
  assert.equal(r2.output, "decent");
});

test("成功回合但什么都没留下 ⇒ thin（跑完了不等于做完了）", () => {
  const r = judgeSingleArm({ rounds: [{ status: "ok" }, { status: "ok" }] });
  assert.equal(r.health, "runs");
  assert.equal(r.output, "thin");
  assert.ok(r.message.includes("没有留下"));
});

test("任何返回都不含裁决/胜负字段（单臂没有对照，不给结论）", () => {
  const samples = [
    judgeSingleArm({ errors: ["401"] }),
    judgeSingleArm({ rounds: [] }),
    judgeSingleArm({ rounds: [{ status: "ok", reportLanded: true }] }),
    judgeSingleArm({ rounds: [{ status: "ok" }] }),
  ];
  for (const s of samples) {
    assert.equal(assertionNoVerdict(s), true, JSON.stringify(s));
    assert.equal(HEALTH.includes(s.health), true);
    assert.equal(OUTPUT.includes(s.output), true);
  }
});

test("混合：部分成功 ⇒ runs，产出按有没有留下东西判", () => {
  const r = judgeSingleArm({ rounds: [{ status: "failed" }, { status: "ok", reportLanded: true }] });
  assert.equal(r.health, "runs");
  assert.equal(r.output, "decent");
  assert.equal(r.evidence.ok, 1);
});
