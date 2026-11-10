#!/usr/bin/env node
// /readyz 的语义（openspec: harden-fleet-execution-economics 5.x）
//
// 为什么要这个端点：/api/ready 在 cell 里、被网关挡在鉴权后面（2026-11-08 实测
// pod 内直连 401），k8s 探针永远读不到队列。钉三条：
//
//   1. 某个 cell 报 degraded → 503，且 503 的 body 说清是哪个 cell；
//   2. 问不到某个 cell → **不算失败**（unknown），探针不能因为一个 cell 慢就摘流量；
//   3. 没有任何 cell → 200（不是 503，空系统不是"坏了"）。
//
// 测试对象是**聚合语义**：路由里那一段依赖 express + registry + fetch，且错误分支
// （超时、非 200）只有真跑起来才到得了。所以这里复刻同一段聚合逻辑做纯函数测试，
// 并额外用一条断言钉住"复刻与实现同构"——两边一旦走散，下面的测试就会误导。
//
// 注意：纯函数测试无法证明 gateway/index.js 里的实现没写错（同构断言只能覆盖结构）。
// 真链路验证靠部署后 `curl 127.0.0.1:3100/readyz` 看到 `answered`/`unknown`。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// 复刻 /readyz 的聚合逻辑（与 gateway/index.js 中实现同构）。
// 之所以抽成纯函数：路由里那段不可单测（依赖 express + registry + fetch）。
function summarize(cells, answers, { aliveOnly = false } = {}) {
  const known = answers.filter((c) => !c.unknown);
  const queued = known.reduce((n, c) => n + (c.queued ?? 0), 0);
  const oldestQueuedMs = known.reduce((m, c) => Math.max(m, c.oldestQueuedMs ?? 0), 0) || null;
  const degradedCells = known.filter((c) => c.degraded).map((c) => c.cell);
  return {
    // ?probe=alive：只问"这一层还活着吗"（至少一个 cell 答上来），
    // 与"堵着"分开——积压驱动的 503 不该把整个平台摘出 Service。
    ready: aliveOnly ? known.length > 0 || cells.length === 0 : degradedCells.length === 0,
    cells: cells.length,
    answered: known.length,
    unknown: answers.filter((c) => c.unknown).map(({ cell, unknown }) => ({ cell, reason: unknown })),
    queued,
    oldestQueuedMs,
    degradedCells,
  };
}

// 1. 健康
{
  const r = summarize([{ userId: "a" }], [{ cell: "a", queued: 2, oldestQueuedMs: 5000, degraded: false }]);
  assert.equal(r.ready, true);
  assert.equal(r.queued, 2);
  assert.equal(r.oldestQueuedMs, 5000);
}

// 2. 有 cell degraded → 不 ready，且点名
{
  const r = summarize([{ userId: "a" }, { userId: "b" }], [
    { cell: "a", queued: 0, degraded: false },
    { cell: "b", queued: 12, oldestQueuedMs: 8_880_000, degraded: true },
  ]);
  assert.equal(r.ready, false);
  assert.deepEqual(r.degradedCells, ["b"]);
  assert.equal(r.queued, 12);
  assert.equal(r.oldestQueuedMs, 8_880_000);
}

// 3. 问不到 → unknown，但不算失败
{
  const r = summarize([{ userId: "a" }, { userId: "b" }], [
    { cell: "a", queued: 1, degraded: false },
    { cell: "b", unknown: "timeout" },
  ]);
  assert.equal(r.ready, true, "an unanswered cell must not fail readiness");
  assert.equal(r.answered, 1);
  assert.deepEqual(r.unknown, [{ cell: "b", reason: "timeout" }]);
  assert.equal(r.queued, 1);
}

// 4. 全部问不到 → 仍然 ready（fail-open），但 answered=0 可见
{
  const r = summarize([{ userId: "a" }], [{ cell: "a", unknown: "http 401" }]);
  assert.equal(r.ready, true);
  assert.equal(r.answered, 0);
  assert.equal(r.queued, 0);
}

// 5. 没有 cell → ready，oldestQueuedMs 为 null（不是 0 冒充"没人等"）
{
  const r = summarize([], []);
  assert.equal(r.ready, true);
  assert.equal(r.oldestQueuedMs, null);
}

// 6. probe=alive：积压报 degraded 也不算不活（2026-11-09 实测 40 分钟 503 的教训）
{
  const cells = [{ userId: "a" }];
  const answers = [{ cell: "a", queued: 12, oldestQueuedMs: 8_880_000, degraded: true }];
  assert.equal(summarize(cells, answers).ready, false, "默认语义：degraded → 503（给人/告警）");
  assert.equal(summarize(cells, answers, { aliveOnly: true }).ready, true,
    "探针语义：有人答上来就是活着，积压不该摘流量");
}

// 7. probe=alive：全都答不上来才是 dead
{
  assert.equal(summarize([{ userId: "a" }], [{ cell: "a", unknown: "timeout" }], { aliveOnly: true }).ready, false);
  assert.equal(summarize([], [], { aliveOnly: true }).ready, true, "空部署仍算活（沿用默认的 fail-open）");
}

console.log("readyz: all assertions passed");

// ── 路由必须可达（2026-11-09 线上实测暴露）──────────────────────────────
//
// 上面那些测的是聚合语义；**它们全绿，而线上 /readyz 返回的是 SPA 的 HTML**：
// 网关的 SPA 兜底正则（gateway/index.js 顶部）没有排除 readyz，我的路由注册在
// 它之后，于是永远轮不到。纯函数测试天生看不见这一类——所以这里直接断言兜底
// 正则的形状（它是唯一决定"路由能不能到达"的东西）。
{
  const src = fs.readFileSync(path.join(here, "..", "gateway", "index.js"), "utf8");
  const line = src.split("\n").find((l) => l.includes("app.get(/^\\/(?!")) ?? "";
  assert.ok(line, "SPA fallback route not found — was it renamed or removed?");
  assert.ok(/healthz\$/.test(line), "fallback should still pass /healthz through");
  assert.ok(/readyz\$/.test(line), "fallback MUST pass /readyz through, else the probe endpoint is dead");
  console.log("readyz: SPA fallback excludes /readyz");

  // ?probe=alive 必须真的存在于实现里。上面的复刻测试测的是"我写的复刻"，
  // 实现要是没这段，复刻全绿也毫无意义——同构断言就是防这个。
  assert.ok(
    /probe\s*===\s*["']alive["']/.test(src) || /query\?\.probe/.test(src),
    "gateway/index.js must implement ?probe=alive, else the liveness semantics are fiction",
  );
  assert.ok(/aliveOnly\s*\?/.test(src), "the alive branch must actually decide `ready`");
  console.log("readyz: ?probe=alive exists in the implementation");
}
