// 舰队 MCP 拒绝话术（2026-10-29 §15.88 真机诊断）。
//
// 为什么单独测这个：常务岗三件工具按岗授权，而 MCP 工具清单是每 cell 静态的，
// 非常务岗看得见、点得动、必然被拒。真机里 CEO 岗在成功的一轮里连点
// decision_queue 三次，每次只拿回一句光秃秃的拒绝——信息量不足以让它停下。
// 现在拒绝要自带「结论 + 下一步」，且必须区分两种 403：
//   · 不是常务岗      → 收手去报数（指它去 escalate-to-owner 会再烧两步，那工具它同样调不通）
//   · 常务岗越权      → 上升给主人
//
// Run: node --test scripts/test-fleet-mcp-hints.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { deputyDeniedText, deputyToolErrorText, decisionResolveErrorText, DEPUTY_ONLY_HINT } from "../server/fleet-mcp-hints.js";

test("非常务岗的拒绝自带结论与下一步（不是光秃秃一句 not the deputy）", () => {
  const text = deputyDeniedText("this post is not the fleet's delegated deputy");
  assert.ok(text.startsWith("this post is not the fleet's delegated deputy"), "原错误原样保留在最前");
  assert.match(text, /不要换参数重试/, "明确禁掉换参数重试");
  assert.match(text, /report_status/, "给出下一步：报数");
  assert.match(text, /escalate/, "给出另一条下一步");
  assert.equal(text, `this post is not the fleet's delegated deputy — ${DEPUTY_ONLY_HINT}`);
});

test("只有 403 才被当作「非常务岗」；其余状态原样透传", () => {
  assert.match(deputyToolErrorText("nope", 403), /不要换参数重试/);
  assert.equal(deputyToolErrorText("upstream 500", 500), "upstream 500", "500 不得被当成权限问题加话术");
  assert.equal(deputyToolErrorText("rate limited", 429), "rate limited", "429 也不加");
});

test("decision_resolve 两种 403 分开处理：非常务岗去报数，越权上升主人", () => {
  // 非常务岗：不能指它去 decision_escalate_to_owner（那工具同样调不通）
  const notDeputy = decisionResolveErrorText("this post is not the fleet's delegated deputy", 403);
  assert.match(notDeputy, /不要换参数重试/);
  assert.ok(!/decision_escalate_to_owner/.test(notDeputy), "非常务岗不该被指去一个它也调不通的工具");

  // 常务岗越权：这才是「上升给主人」的场景
  const overMandate = decisionResolveErrorText("beyond delegation mandate — category 'spend' is routed to owner", 403);
  assert.match(overMandate, /decision_escalate_to_owner/, "越权要指向上报主人");
  assert.ok(!/不要换参数重试/.test(overMandate), "越权不是「别重试」而是「换条路」");

  // 预算用尽（429）同样上升
  assert.match(decisionResolveErrorText("deputy daily ruling budget reached", 429), /decision_escalate_to_owner/);

  // 其它错误（参数错/条目已被裁）加话术没有意义，原样返回
  assert.equal(decisionResolveErrorText("choice must be one of: a, b", 400), "choice must be one of: a, b");
  assert.equal(decisionResolveErrorText("already approved", 409), "already approved");
});
