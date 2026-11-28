#!/usr/bin/env node
// ── 连接页 panel 锚点一致性（change converge-line-identity-and-keys 4.4）──────
//
// 4.4 的验收里有一句「全站无死链」。死链在这一层长这样：门总览按
// `?panel=<id>` 渲染「去连接」，而 `<id>` 没有对应卡片 ⇒ 点进去是「连接页，
// 什么都没高亮」，与「这条线本来就没卡」同形——不报错、不红、没人发现。
//
// 2026-11-17 实测到的就是这一处：门 A 成员行按 `line-${line}` 拼 panel，锚点却只有
// `line-lex` / `line-wire-customer`，线上已声明成员轨的 `finddata-business` 今天
// 就渲染 `?panel=line-finddata-business`（空跳）；`line-wire` 同理落空（真锚点是
// `line-wire-customer`——连接条目 id 与凭据 ref 名不是同一套命名）。
//
// 这组用例把**三侧**钉在一起，任一侧漂移就红：
//   ① `web/src/lib/connect-panels.ts` 的名单
//   ② `ConnectionsSection.tsx` 里所有 `ids={[...]}`（真正渲染锚点的地方）
//   ③ 服务端 `DOOR_OF`（`/api/connections` 的条目 id 表，门总览按它取 id）
//
//   node --test --test-concurrency=1 scripts/test-connect-panels.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

// 名单文件是 TS；只取 `export const CONNECT_PANEL_IDS = [` … `]` 之间的字符串字面量，
// 不引 TS 运行时（本仓测试是 .mjs，跑在 node 上）。
function constantIds() {
  const src = read("web/src/lib/connect-panels.ts");
  const block = src.match(/export const CONNECT_PANEL_IDS = \[([\s\S]*?)\] as const;/);
  assert.ok(block, "connect-panels.ts 里应有 `export const CONNECT_PANEL_IDS = [...] as const;`");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

// 真正渲染锚点的地方：`<CardAnchor ids={["a", "b"]} …>`。
function anchorIds() {
  const src = read("web/src/components/settings/ConnectionsSection.tsx");
  const out = [];
  for (const m of src.matchAll(/ids=\{\[([^\]]*)\]\}/g)) {
    out.push(...[...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  }
  return out;
}

test("名单与真正渲染的锚点逐项相同（多一个→有人写了不存在的卡；少一个→卡片连不上）", () => {
  const declared = constantIds();
  const rendered = anchorIds();
  assert.ok(rendered.length >= 10, `锚点数应有两位数，实得 ${rendered.length}`);

  const onlyDeclared = declared.filter((id) => !rendered.includes(id));
  const onlyRendered = rendered.filter((id) => !declared.includes(id));
  assert.deepEqual(onlyDeclared, [], `名单里有、页面上没有的锚点：${onlyDeclared.join(", ")}`);
  assert.deepEqual(onlyRendered, [], `页面上有、名单里漏掉的锚点：${onlyRendered.join(", ")}`);
  // 同一 id 挂两张卡是允许的（一张卡可以接旧 id 与新 id），但名单自身不许重复。
  assert.equal(new Set(declared).size, declared.length, "名单里不许有重复 id");
});

test("服务端每个连接条目 id 都在名单里（否则门总览那一行就没有去处）", async () => {
  const { DOOR_OF } = await import("../server/lib/credential-doors.js");
  const declared = new Set(constantIds());
  const missing = Object.keys(DOOR_OF).filter((id) => !declared.has(id));
  assert.deepEqual(missing, [], `DOOR_OF 里这些条目没有卡片：${missing.join(", ")}`);
});

test("hasConnectPanel：只有在册且非空才给链接（直接跑真函数）", async () => {
  // Node 26 起 .ts 可直接 import（类型剥除），所以这里测的是**真函数**，
  // 不是重写一遍的语义。若某天解释器不支持，这条会以 import 错误红掉，
  // 那时再退回源码形状断言——别默默降级。
  const { hasConnectPanel, CONNECT_PANEL_IDS } = await import("../web/src/lib/connect-panels.ts");
  assert.equal(typeof hasConnectPanel, "function", "应导出 hasConnectPanel");

  assert.equal(hasConnectPanel("line-lex"), true, "在册");
  assert.equal(hasConnectPanel("registry"), true, "在册");
  assert.equal(hasConnectPanel(null), false, "null 不给链接");
  assert.equal(hasConnectPanel(undefined), false, "undefined 不给链接");
  assert.equal(hasConnectPanel(""), false, "空串不给链接");
  assert.equal(hasConnectPanel("line-wire"), false, "不在册（wire 的卡叫 line-wire-customer）");
  assert.equal(
    hasConnectPanel("line-finddata-business"),
    false,
    "成员轨为 finddata-business 的线没有卡 ⇒ 它那一行今天就不该有「去连接」",
  );

  // 名单本身不许重复，且必须仍是「集合查询」实现（写成「非空即真」就是这次修的缺陷）
  assert.equal(new Set(CONNECT_PANEL_IDS).size, CONNECT_PANEL_IDS.length, "名单里不许有重复 id");
  const src = read("web/src/lib/connect-panels.ts");
  assert.match(src, /new Set<string>\(CONNECT_PANEL_IDS\)/, "判定必须走名单集合");
  assert.match(src, /PANEL_SET\.has\(panel\)/, "判定必须是 has()，不是判非空");
});
