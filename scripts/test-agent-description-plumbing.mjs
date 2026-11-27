// ── agent 的 description 一路走到 facade 卡片 ────────────────────────────────
//
// 2026-11-25 真机走查发现：facade 目录里两支 agent 没有说明文字，而上游 registry
// 的 `/api/agents` 明明给了 description。断成两处硬编码：
//   · registry-bridge.js 的 mapAgent 没把 `a.description` 映射出去；
//   · facet/index.js 的 agentEntries 直接写死 `description: ""`。
// 上游 20 支 agent 里 18 支带描述 —— 也就是说这条链丢了几乎所有说明文字，
// 只是渲染层用 `?? zhFallbackAnnotation` 兜住了，所以没人发现。
//
// 这两处都是「数据在上一层有，下一层把它扔了」的形态，单元测试打不到（桥接要
// 活的上游）。这里改为对映射函数的**行为**断言，而不是对源码做字符串匹配。

import { test } from "node:test";
import assert from "node:assert/strict";

test("mapAgent 把上游的 description 带出去", async () => {
  const { __test_mapAgent } = await import("../registry-bridge.js");
  assert.ok(typeof __test_mapAgent === "function", "mapAgent must be reachable for tests");
  const entry = __test_mapAgent({
    path: "/packs/abc/spider-heal",
    name: "爬虫自愈修复",
    description: "按健康工单定向修复 spider 单元",
    url: "http://example.test/agent",
  });
  assert.ok(entry, "an enabled agent with a url maps");
  assert.equal(entry.description, "按健康工单定向修复 spider 单元");
});

test("上游没给 description 时是空串，不是 undefined", async () => {
  const { __test_mapAgent } = await import("../registry-bridge.js");
  const entry = __test_mapAgent({ path: "/x", name: "X", url: "http://e.test/a" });
  assert.equal(entry.description, "");
});

test("非字符串的 description 读作空串（不把对象塞进显示层）", async () => {
  const { __test_mapAgent } = await import("../registry-bridge.js");
  const entry = __test_mapAgent({ path: "/y", name: "Y", description: { bogus: 1 }, url: "http://e.test/b" });
  assert.equal(entry.description, "");
});

test("facade 投影把 agent 的 description 用作兜底摘要", async () => {
  const { projectFacadeEntries } = await import("../facet/supply-catalog.js");
  const { facades } = projectFacadeEntries(
    [{ slug: "abc-spider-heal", name: "爬虫自愈修复", description: "按健康工单定向修复 spider 单元", status: "serving" }],
    { asOf: "2026-11-25" },
  );
  assert.equal(facades[0].description, "按健康工单定向修复 spider 单元");
  // 没有策展轨时，兜底注释的摘要就该是这句上游描述 —— 不是 slug、不是空。
  assert.equal(facades[0].annotation.human.zh.summary, "按健康工单定向修复 spider 单元");
});
