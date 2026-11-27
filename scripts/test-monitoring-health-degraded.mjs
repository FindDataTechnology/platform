#!/usr/bin/env node
// ── health 面不得自报健康（retire-orphan-platform-state 4.3）──────────────────
//
// 4.2 的审计撞到的真缺陷：`/api/monitoring/health` 把 `status: "healthy"` **写死**，
// 只有整个 handler 抛异常才不是健康。于是「cluster 库读不到 / 读到的是另一个同名库」
// 这种形态下，端点照样回 `healthy` + `clusters:{total:0,active:0}`，而 0 到底是
// 「没有集群」还是「读不出来」**分不开** ⇒ 压在这个面上的所有红绿都不可信。
//
// 判据（六臂）：
//   A. 正常读面 ⇒ healthy，两个数照原样
//   B. **0 是合法答案** ⇒ {0,0} 仍是 healthy（别把修复做成「非零才健康」）
//   C. 读面抛错 ⇒ degraded + clusters:null + 点名来源与原因
//   D. 读面返回空 ⇒ degraded（不是 healthy）
//   E. 读面返回非数 ⇒ degraded 且点名「non-numeric」（0 与 NaN 不是一回事）
//   F. 结构臂：路由源码里不许再出现写死的 healthy 字面量——这条才是原缺陷的回归网
//
//   node --test scripts/test-monitoring-health-degraded.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const { healthSnapshot } = await import(path.join(root, "server/health-snapshot.js"));

test("A. 正常读面 ⇒ healthy，数照原样", () => {
  const body = healthSnapshot({ readClusters: () => ({ total: 2, active: 1 }), uptime: 12 });
  assert.equal(body.status, "healthy");
  assert.deepEqual(body.clusters, { total: 2, active: 1 });
  assert.equal("degraded" in body, false, "健康时不该出现 degraded 键");
});

test("B. 0 是合法答案：没有集群 ⇒ 仍 healthy（修复不等于「非零才健康」）", () => {
  const body = healthSnapshot({ readClusters: () => ({ total: 0, active: 0 }) });
  assert.equal(body.status, "healthy", "空平台是健康状态，不是降级");
  assert.deepEqual(body.clusters, { total: 0, active: 0 });
});

test("C. 读面抛错 ⇒ degraded，clusters 为 null，且点名来源", () => {
  const body = healthSnapshot({
    readClusters: () => { throw new Error("SQLITE_CANTOPEN: unable to open database file"); },
  });
  assert.equal(body.status, "degraded");
  assert.equal(body.clusters, null, "读不出来时不许给一个 0 冒充答案");
  assert.equal(body.degraded.length, 1);
  assert.match(body.degraded[0], /cluster-store/);
  assert.match(body.degraded[0], /SQLITE_CANTOPEN/);
});

test("D. 读面返回空 ⇒ degraded（不能读成「没有集群」）", () => {
  const body = healthSnapshot({ readClusters: () => undefined });
  assert.equal(body.status, "degraded");
  assert.equal(body.clusters, null);
  assert.match(body.degraded[0], /returned nothing/);
});

test("E. 读面返回非数 ⇒ degraded，并点名 non-numeric（0 与 NaN 不同）", () => {
  const body = healthSnapshot({ readClusters: () => ({ total: "0", active: null }) });
  assert.equal(body.status, "degraded");
  assert.equal(body.clusters, null);
  assert.match(body.degraded[0], /non-numeric/);
});

test("F. 结构臂：路由源码里不许再写死 healthy", () => {
  const raw = readFileSync(path.join(root, "server/routes/monitoring.js"), "utf8");
  // **先剥注释再判**：路由里那段解释性注释刻意引了这个字面量（说明原缺陷长什么样），
  // 而回退成写死 healthy 会是**代码**里的字面量。不剥注释的断言会被自己那句注释永久
  // 判红，于是一条真回归网退化成「每天都在响」的噪声（这一坑第一版就踩了）。
  const src = stripComments(raw);
  assert.equal(
    src.includes('status: "healthy"'),
    false,
    "health 判词必须由 healthSnapshot 计算，不许在路由代码里写死 healthy",
  );
  assert.ok(src.includes("healthSnapshot("), "路由必须走 healthSnapshot()");
});

/** 去掉 `// …` 行注释与 `/* … *​/` 块注释（够用于本仓的源码风格，不必处理字符串里的 `//`）。 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}
