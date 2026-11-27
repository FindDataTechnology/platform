// ── 目录列表的工具全量数（pack-tool-declaration-gate D4）────────────────────
//
//   node --test scripts/test-facet-mcp-catalog-toolcount.mjs
//
// 包详情要把「这个包声明了几个工具」和「那台服务器一共有几个」并排给读者看。
// 前半来自 manifest，后半来自目录。2026-11-22 上产实测发现：列表端点**从不**
// 回这个数——只有深度端点回。于是 facet 上的工具面永远只报声明数，
// marketCatalog 那条路（壹座的 /api/extensions/market）在 facet 根本 404。
//
// 这个测试钉住列表投影：三种条目形状都得到正确的 toolCount，缺数据是 null
// 而不是 0（未知 ≠ 零，编 0 会让「声明 2 / 全量 0」读成矛盾）。
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { registerFacetMcpRoutes } from "../facet/mcp-catalog.js";

function catalogFor(entries) {
  const app = express();
  registerFacetMcpRoutes(app, {
    resolveUser: () => ({ email: "t@e.st", groups: ["admin"] }),
    entriesFn: () => entries,
  });
  return new Promise((resolve) => {
    const srv = app.listen(0, async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/mcp-catalog`);
        resolve((await r.json()).servers);
      } finally {
        srv.close();
      }
    });
  });
}

test("toolCount comes from the stored tool_list", async () => {
  const servers = await catalogFor([
    { name: "a", displayName: "A", toolList: ["x", "y", "z"], groups: [] },
  ]);
  assert.equal(servers[0].toolCount, 3);
});

test("numTools wins when present (the registry's own count)", async () => {
  const servers = await catalogFor([
    // A stale tool_list (2 names) must not override the authoritative numTools.
    { name: "b", displayName: "B", numTools: 7, toolList: ["x", "y"], groups: [] },
  ]);
  assert.equal(servers[0].toolCount, 7);
});

test("no snapshot ⇒ null, never a fabricated 0", async () => {
  const servers = await catalogFor([{ name: "c", displayName: "C", groups: [] }]);
  assert.equal(servers[0].toolCount, null);
});
