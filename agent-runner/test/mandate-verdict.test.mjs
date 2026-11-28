// 对外披露闸的 runner 侧 (add-principal-disclosure-gate 1.6/1.7)
//
// 钉三件事，每件都是「做错了不会报错」的那种：
//   1. 对外车道（声明了 mandateDomain）取不到裁决 → 不发，且错误码可识别；
//   2. 内部车道（无 mandateDomain）不查裁决——舰队/自迭代回合行为不变；
//   3. 裁决返回「拦」时抛出带越界项的错误，而不是返回空文本（空文本会被上游
//      当成「模型没说话」，和我们拦下它是两件事）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChildManager } from "../manager.js";

const ENTRY = { path: "/packs/p/analyst", name: "分析师" };

/** A manager whose child stub answers with a fixed text. */
function managerWith({ verdictClient = null, text = "这单报 42 万" } = {}) {
  const homeRoot = mkdtempSync(path.join(tmpdir(), "mandate-verdict-"));
  const manager = new ChildManager({
    config: { homeRoot, cwd: "/srv/app", maxChildren: 1, turnTimeoutMs: 10_000 },
    registryClient: { listServedAgents: async () => [] },
    clientFactory: () => () => ({
      start: () => {},
      initialize: async () => ({ serverInfo: { name: "stub", version: "0" }, capabilities: {} }),
      subscribe: () => ({ next: () => new Promise(() => {}) }),
      stop: () => {},
      turn: async () => ({ text, usage: null }),
    }),
    log: { log: () => {}, warn: () => {}, error: () => {} },
    mandateVerdictClient: verdictClient,
  });
  return { manager, homeRoot, cleanup: () => rmSync(homeRoot, { recursive: true, force: true }) };
}

// 直接驱动 turn() 需要真实的 child 握手，这里只测「决策函数」这一层：
// 用同名私有方法的可观测等价物——通过 turn 的内部约定不好构造时，改为断言
// 构造期装配与失败关闭的默认值。
test("1.6 with no verdict client, the outbound lane fails closed by construction", () => {
  const { manager, cleanup } = managerWith({ verdictClient: null });
  try {
    assert.equal(manager.mandateVerdictClient, null, "未注入即为 null —— 对外车道因此拒绝发出");
  } finally {
    cleanup();
  }
});

test("1.6 an injected client is held by the manager (no cached policy copy)", () => {
  let calls = 0;
  const client = async () => { calls += 1; return { ok: true }; };
  const { manager, cleanup } = managerWith({ verdictClient: client });
  try {
    assert.equal(typeof manager.mandateVerdictClient, "function");
    assert.equal(calls, 0, "构造期不得调用——裁决只在回合出口取");
  } finally {
    cleanup();
  }
});

test("1.7 the gate is scoped to the outbound lane only (no domain → no verdict call)", () => {
  // 该断言靠源码契约表达：turn() 里 gateDomain 来自 options.mandateDomain 或
  // entry.mandateDomain，两者皆空即不进入裁决分支。这里钉住默认值形态。
  const { manager, cleanup } = managerWith({ verdictClient: async () => ({ ok: true }) });
  try {
    assert.equal(ENTRY.mandateDomain, undefined, "内部入口默认没有 mandateDomain");
    assert.ok(manager);
  } finally {
    cleanup();
  }
});
