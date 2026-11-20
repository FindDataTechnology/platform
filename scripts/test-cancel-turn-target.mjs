#!/usr/bin/env node
// ── cancelTurn must stop the turn it was asked to stop ──────────────────────
//
// 2026-11-20 实测（生产，`packs-99umqiqxf5tprugl6sifag-probe-agent`）：
// `tasks/cancel` 对一个正在跑的回合返回 `state: running`，回合随后正常跑完。
// 根因是 cancelTurn 拿**裸 sessionId** 去问 adapter 的活跃表，而 pod 成员的
// collector 是按 **wire id**（`<agentKey>--<sessionId>`）落的 —— 于是「有没有在
// 跑」永远答 false，cancel 报 not-running（200），实际什么都没停。
//
// 这个文件钉两件事，都在不拉起真 dsh 的前提下可验：
//   1. 活跃探测必须**同时**认两种 id 形状（pod / 非 pod），因为适配器按自己
//      的 podMembers 决定用哪个，而 manager 的 route 分组可能与它不一致；
//   2. `session/cancel` 必须发给**真正活跃的那个 id**，不是路由推出来的那个。
//
//   node --test scripts/test-cancel-turn-target.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const { ChildManager } = await import("../agent-runner/manager.js");
const { DshHarnessAdapter } = await import("../agent-runner/harness/dsh.js");

test("wire id is the id the ADAPTER keys collectors by (the shape that broke)", () => {
  // The adapter's own static derivation is the contract; pin it so a rename
  // cannot silently make the manager probe the wrong key again.
  assert.equal(DshHarnessAdapter.wireSessionId("packs-p1-a", "wx:abc"), "packs-p1-a--wx:abc");
});

test("cancelTurn probes BOTH id shapes and cancels the one that is actually active", async () => {
  // Build a manager instance without spawning: the class only needs `groups`,
  // `children`, and `now` for this path.
  const m = Object.create(ChildManager.prototype);
  const key = "packs-p1-a";
  const sessionId = "wx:live";
  const wire = DshHarnessAdapter.wireSessionId(key, sessionId);

  const requests = [];
  const child = {
    // The adapter knows the turn is running, and it is keyed by the WIRE id —
    // exactly the case where the old bare-id probe answered false.
    isActive: (id) => id === wire,
    adapter: { capabilities: () => ({ cancel: true }) },
    request: async (method, params) => { requests.push({ method, params }); return { accepted: true }; },
  };
  m.groups = new Map([[key, { childKey: key, pod: true }]]);
  m.children = new Map([[key, child]]);

  const entry = { path: "/packs/p1/a", name: "a" };
  const out = await m.cancelTurn(entry, sessionId);

  assert.equal(out.stopped, "cancelled", "a running turn must be stopped, not reported not-running");
  assert.equal(requests.length, 1, "exactly one session/cancel is sent");
  assert.equal(requests[0].method, "session/cancel");
  assert.equal(requests[0].params.sessionId, wire, "the cancel must address the id the adapter is keyed by");
});

test("cancelTurn still answers not-running when NOTHING is active (no fake stop)", async () => {
  const m = Object.create(ChildManager.prototype);
  const key = "packs-p1-a";
  const child = {
    isActive: () => false,
    adapter: { capabilities: () => ({ cancel: true }) },
    request: async () => { throw new Error("must not be called"); },
  };
  m.groups = new Map([[key, { childKey: key, pod: true }]]);
  m.children = new Map([[key, child]]);
  const out = await m.cancelTurn({ path: "/packs/p1/a", name: "a" }, "wx:idle");
  assert.equal(out.stopped, "not-running");
});

test("cancelTurn reports unsupported rather than pretending (harness without a cancel lane)", async () => {
  const m = Object.create(ChildManager.prototype);
  const key = "packs-p1-a";
  const wire = DshHarnessAdapter.wireSessionId(key, "wx:x");
  const child = {
    isActive: (id) => id === wire,
    adapter: { capabilities: () => ({ cancel: false }) },
    request: async () => { throw new Error("must not be called"); },
  };
  m.groups = new Map([[key, { childKey: key, pod: true }]]);
  m.children = new Map([[key, child]]);
  const out = await m.cancelTurn({ path: "/packs/p1/a", name: "a" }, "wx:x");
  assert.equal(out.stopped, "unsupported", "a harness that cannot abort must never be presented as one that did");
});
