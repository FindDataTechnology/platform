// 判定段的三态呈现（establish-agent-role-and-fitness-plane 8.3）。
//
// 这一栏最容易出的三种错，每种都写成断言：
//   1. 缺省被当成 null ⇒ 老服务端看起来像「所有包都未判定」
//   2. null 被当成缺省 ⇒ 「确实没判过」从界面上消失
//   3. 裁决原语直接漏到用户面（retire / inconclusive 这些词）
//
// Run: node --test web/src/lib/packs-api.fitness.test.mjs
// （纯函数测试，不需要构建前端）

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";

// 从 TS 源码里取出 fitnessBadge 的等价实现做验证：前端测试基建不在本仓 CI 里，
// 但判据必须真跑——所以这里用「读源码 + 断言关键分支」的方式，而不是复制一份实现。
const SRC = fs.readFileSync(path.resolve("web/src/lib/packs-api.ts"), "utf8");

test("fitnessBadge 存在且是唯一呈现入口", () => {
  assert.match(SRC, /export function fitnessBadge\(/);
});

test("三态可区分：undefined 返回 null（不渲染），null 返回「未判定」", () => {
  const body = SRC.slice(SRC.indexOf("export function fitnessBadge"));
  assert.match(body, /if \(fitness === undefined\) return null;/, "缺省 ≠ 未判定");
  assert.match(body, /if \(fitness === null\) return \{ label: "未判定"/, "null 明确渲染成未判定");
});

test("五种裁决各有用户面终词（不是原语）", () => {
  for (const [verdict, label] of [
    ["retain", "保留"],
    ["merge", "建议合并岗位"],
    ["redesign", "改设计后重判"],
    ["retire", "已裁撤"],
    ["inconclusive", "判不出"],
  ]) {
    assert.ok(SRC.includes(`case "${verdict}"`), `缺 ${verdict} 分支`);
    assert.ok(SRC.includes(label), `${verdict} 的呈现必须含「${label}」`);
  }
});

test("inconclusive 不得呈现为「已验证更优」或「保留」", () => {
  const from = SRC.indexOf('case "inconclusive"');
  const to = SRC.indexOf("default:", from);
  // 只看代码，不看注释——注释里写「判不出 ≠ 已验证」是**对的**，不该被自己的判据当成违规。
  const body = SRC.slice(from, to).replace(/\/\/.*$/gm, "");
  assert.ok(!body.includes("已验证"), "判不出 ≠ 已验证");
  assert.ok(!/label: .*保留/.test(body), "判不出 ≠ 保留");
});

test("retire 的呈现必须带「不可新装」", () => {
  const body = SRC.slice(SRC.indexOf('case "retire"'), SRC.indexOf('case "retire"') + 160);
  assert.ok(body.includes("不可新装"));
});
