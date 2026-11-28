// 蓝图校验器的成员指向核对（close-dangling-persona-refs）。
// Run: node --test scripts/test-blueprint-validate.mjs

import assert from "node:assert/strict";
import { test } from "node:test";


// 悬空 persona 引用（2026-11-28 生产 e2e 实撞）。
// 两个官方模板的 risk 岗指向 `{{RISK_PERSONA}}`，而校验器只查 pack-preset，
// existing-persona 从闸门底下走过去——模板装出来一个空岗，提示只有
// 「1 个岗位因目标缺位降生为空岗，可后补」。
// existing-persona 指向的是**运行时 catalog**（fleet-provisioner 的 resolveExisting），
// 不是本包 agents[]。所以「本包没声明」对它不是错误——company-fleet 模板刻意用它
// 表示「部署时由买家指定」。真正要拦的只有「占位符没有解析器」。
test("existing-persona 指向本包未声明的 id ⇒ 不报错（那是运行时 catalog）", async () => {
  const { memberClosureFindings } = await import("../server/blueprint-validate.js");
  const f = memberClosureFindings({ agents: [{ id: "a1" }], fleet: { members: [{ ref: "risk", target: { kind: "existing-persona", id: "nope" } }] } });
  assert.deepEqual(f, [], "existing-persona 的 id 属于运行时 catalog，不该按包内 agents 判");
});

test("无解析器的双花括号占位符 ⇒ 单独一类报错", async () => {
  const { memberClosureFindings } = await import("../server/blueprint-validate.js");
  const f = memberClosureFindings({ agents: [{ id: "a1" }], fleet: { members: [{ ref: "risk", target: { kind: "existing-persona", id: "{{RISK_PERSONA}}" } }] } });
  assert.equal(f.length, 1);
  assert.equal(f[0].code, "fleet_preset_placeholder_unresolved");
  assert.match(f[0].error, /no resolver/);
});

test("有解析器的 ${param} 仍然豁免", async () => {
  const { memberClosureFindings } = await import("../server/blueprint-validate.js");
  const f = memberClosureFindings({ agents: [{ id: "a1" }], fleet: { members: [{ target: { kind: "existing-persona", id: "${chosen}" } }] } });
  assert.deepEqual(f, []);
});
