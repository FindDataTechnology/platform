// ── 跨服务工具搜索（polish-facet-mcp-surface 1.1 / 1.2）──────────────────────
//
//   node --test scripts/test-facet-mcp-catalog-toolsearch.mjs
//
// 读者知道工具名或主题、但不知道它在哪台服务器上。列表载荷按 spec 不含工具面，
// 所以搜索必须走独立端点；这个测试钉住四件事：
//
//   · 命中只出现在工具面里（服务器卡片文案没有那个词时也要搜得到）
//   · 可见性沿用卡片列表的判定——不可见服务器的工具不出现，也不泄露条数
//   · 空 q 返回空数组（不变成拉全量的后门）
//   · 注释按请求 locale 投影
//
// 匹配语义与客户端 filterTools 共用一条谓词（D7）：同一 needle 两边命中同一集合。
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { registerFacetMcpRoutes } from "../facet/mcp-catalog.js";
import { filterTools } from "../facet/web/src/mcpDepthTools.ts";

const zhAnn = (name, summary) => ({
  human: { zh: { name, summary }, en: { name: `EN ${name}`, summary: `EN ${summary}` } },
  provenance: { source: "test" },
});

const ENTRIES = [
  {
    name: "daas",
    displayName: "daas",
    // Card-level text deliberately says nothing about alerts — the whole point
    // of cross-server search is reaching a tool whose server card does not
    // mention it.
    description: "Data as a service",
    groups: [],
    toolDetails: [
      { name: "alerts_create_alert_rule", description: "Create a trigger rule over a DB series." },
      { name: "cron_list_schedules", description: "List cron schedules." },
    ],
    annotations: { tools: { alerts_create_alert_rule: zhAnn("创建告警规则", "在数据序列上建一条触发规则。") } },
  },
  {
    name: "hidden",
    displayName: "hidden",
    description: "Group-gated server",
    groups: ["ops"],
    toolDetails: [{ name: "alerts_secret", description: "Alerts nobody outside ops may see." }],
  },
  {
    name: "empty",
    displayName: "empty",
    description: "No snapshot captured",
    groups: [],
    toolDetails: null,
  },
];

function search(query, { groups = [], locale = "zh" } = {}) {
  const app = express();
  registerFacetMcpRoutes(app, {
    resolveUser: () => ({ email: "t@e.st", groups }),
    entriesFn: () => ENTRIES,
  });
  return new Promise((resolve) => {
    const srv = app.listen(0, async () => {
      try {
        const r = await fetch(
          `http://127.0.0.1:${srv.address().port}/api/mcp-catalog/tools?q=${encodeURIComponent(query)}&locale=${locale}`,
        );
        resolve(await r.json());
      } finally {
        srv.close();
      }
    });
  });
}

test("1.1 a tool is findable without knowing its server", async () => {
  const { results } = await search("告警");
  assert.equal(results.length, 1);
  assert.equal(results[0].server, "daas");
  assert.equal(results[0].tool, "alerts_create_alert_rule");
  assert.equal(results[0].name, "创建告警规则");
});

test("1.1 an invisible server contributes nothing, and its count is not disclosed", async () => {
  // The viewer's groups do not include "ops": the hidden server's
  // alerts_secret must not appear, and results must not hint that it exists.
  const { results } = await search("告警");
  assert.deepEqual(results.map((r) => r.tool), ["alerts_create_alert_rule"]);

  const opsOnly = await search("secret", { groups: [] });
  assert.deepEqual(opsOnly.results, []);
  // The same query WITH the group does find it — proving the absence above is
  // the visibility gate, not a missing tool.
  const withGroup = await search("secret", { groups: ["ops"] });
  assert.deepEqual(withGroup.results.map((r) => r.server), ["hidden"]);
});

test("1.1 an empty query answers empty, never the whole inventory", async () => {
  for (const q of ["", "   "]) {
    const { results } = await search(q);
    assert.deepEqual(results, []);
  }
});

test("1.1 a server with no captured snapshot contributes no rows and does not throw", async () => {
  const { results } = await search("anything");
  assert.deepEqual(results, []);
});

test("1.1 results carry the requested locale's annotation", async () => {
  const { results } = await search("告警", { locale: "en" });
  assert.equal(results[0].name, "EN 创建告警规则");
  assert.equal(results[0].summary, "EN 在数据序列上建一条触发规则。");
});

test("1.2 endpoint and filterTools agree on the same needle", async () => {
  // For every needle, the set of (server, tool) the endpoint returns, restricted
  // to servers the viewer sees, equals what the client-side filter would keep
  // on the same tool surface. This is the contract the two screens share.
  const visible = ENTRIES.filter((e) => (e.groups ?? []).length === 0 && Array.isArray(e.toolDetails));
  const deepTools = visible.flatMap((e) =>
    e.toolDetails.map((t) => ({
      ...t,
      annotation: e.annotations?.tools?.[t.name]
        ? { name: e.annotations.tools[t.name].human.zh.name, summary: e.annotations.tools[t.name].human.zh.summary }
        : null,
    })),
  );
  for (const needle of ["告警", "alert", "cron", "规则", "series", "zzz-no-match"]) {
    const { results } = await search(needle);
    const fromEndpoint = new Set(results.map((r) => r.tool));
    const fromFilter = new Set(filterTools(deepTools, needle).map((t) => t.name));
    assert.deepEqual([...fromEndpoint].sort(), [...fromFilter].sort(), `needle=${needle}`);
  }
});
