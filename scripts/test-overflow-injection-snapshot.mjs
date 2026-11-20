#!/usr/bin/env node
// ── 溢出回合的注入面快照（mcp-injection-budget-residual 3.1/3.2）──────────────
//
// 3.1：`CONTEXT_WINDOW_EXCEEDED` 回合的 turn detail 要带注入面快照（server 数 +
// 技能字节）。3.2：正常回合**不新增字段**——detail 逐键与改动前相同。
//
// 这两条是一对，缺一条就会把「加了字段」写成「到处都有字段」。判据全部打在
// `contextPressureDetail` 的返回值上（它是 detail 的唯一构造点）：
//   A. 真溢出 ⇒ 有 `injectionSurface{servers, skillRoots, skillBytes}`
//   B. 压缩风暴（压力但**不是**溢出）⇒ 有 detail，但**没有**该键
//   C. 正常回合（无压力）⇒ 返回 null（连 detail 都没有）
//   D. 快照来源抛错/为 null ⇒ 不写该键（缺了就是缺了，不写 0）
//   E. 传入函数时**只在溢出那条路**被调用（不该为压缩风暴付读盘的钱）
//
//   node --test scripts/test-overflow-injection-snapshot.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { contextPressureDetail } = await import(path.join(here, "../server/cron-runner.js"));

const OVERFLOW_MSG = "pi-ai detected context overflow: CONTEXT_WINDOW_EXCEEDED";
const FACE = { servers: 5, skillRoots: 3, skillBytes: 12345, serverNames: ["a", "b", "c", "d", "e"], patchPresent: true };

test("A. 真溢出 ⇒ detail 带注入面快照", () => {
  const detail = contextPressureDetail(OVERFLOW_MSG, { injectionSurface: FACE });
  assert.ok(detail, "溢出必须产出 detail");
  assert.equal(detail.overflow, true);
  assert.deepEqual(detail.injectionSurface, { servers: 5, skillRoots: 3, skillBytes: 12345 });
});

test("B. 压缩风暴（有压力但不是溢出）⇒ 有 detail，但**没有**注入面键", () => {
  const detail = contextPressureDetail("turn stopped early — context pressure", { compactions: 9, injectionSurface: FACE });
  assert.ok(detail, "压缩风暴仍要有 detail");
  assert.equal(detail.overflow, undefined, "这不是溢出");
  assert.equal("injectionSurface" in detail, false,
    "3.2：非溢出回合的 detail 必须逐键与改动前相同——多一个键就是改了口径");
});

test("C. 正常回合 ⇒ null（连 detail 都没有，更不会多键）", () => {
  assert.equal(contextPressureDetail("everything fine", { compactions: 0, injectionSurface: FACE }), null);
});

test("D. 快照来源缺席或抛错 ⇒ 不写该键（缺了就是缺了，不写 0）", () => {
  const absent = contextPressureDetail(OVERFLOW_MSG, {});
  assert.equal("injectionSurface" in absent, false, "没有输入就不造字段");

  const boom = contextPressureDetail(OVERFLOW_MSG, {
    injectionSurface: () => { throw new Error("disk gone"); },
  });
  assert.equal("injectionSurface" in boom, false, "读盘失败不许让 detail 构造崩，也不许伪造 0");

  const empty = contextPressureDetail(OVERFLOW_MSG, { injectionSurface: {} });
  assert.equal("injectionSurface" in empty, false, "什么都不认的输入 ⇒ 不写");
});

test("E. 传函数时只在溢出那条路被调用（压缩风暴不付读盘的钱）", () => {
  let calls = 0;
  const thunk = () => { calls += 1; return FACE; };

  contextPressureDetail("turn stopped early — context pressure", { compactions: 9, injectionSurface: thunk });
  assert.equal(calls, 0, "压缩风暴不该读盘");

  contextPressureDetail(OVERFLOW_MSG, { injectionSurface: thunk });
  assert.equal(calls, 1, "溢出才读一次");
});
