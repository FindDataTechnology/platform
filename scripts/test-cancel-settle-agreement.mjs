#!/usr/bin/env node
// ── 取消与完成同时发生时，两侧必须说同一个终态 ──────────────────────────────
//
// 规格 `a2a-task-handle`「取消与完成同时发生」：系统 SHALL 给出唯一答案
// （要么按完成、要么按取消），MUST NOT 两侧各报一种状态。
//
// 2026-11-21 生产实测（`packs-kkcie7nlrhluo4likpnn0w-spider-heal`，经 registry）：
//
//   CANCEL    {"state":"cancelled","cancelled_by":"caller:unknown"}
//   SEND      {"code":-32005,"message":"turn ended without any assistant output (model unavailable or refused)"}
//
// 同一个 task_id，取消说「已取消」，答复说「模型不可用」。根因不在 a2a 层：dsh
// 适配器**没有「被取消」这个概念** —— `tasks/cancel` 把 `session/cancel` 发给运行时，
// 运行时回 idle、不再产出正文，于是落进「空回合 = 模型不可用」那条分支
// （harness/dsh.js:519）。a2a 层随后把这个错误原样回给调用者。
//
// 这条用例钉住两侧一致：一个被取消的回合，`message/send` 的答复 MUST 是取消，
// MUST NOT 是 -32005/-32003 这类「失败」。
//
//   node --test scripts/test-cancel-settle-agreement.mjs

import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import { createAgentApp } from "../agent-runner/a2a.js";

const ENTRY = { name: "n", description: "d", version: "1", path: "/agent/x/y/" };
const CONFIG = { backendToken: "tok", registryUrl: "https://mcp.example.test" };
const LOG = { log() {}, warn() {}, error() {} };

function serve(manager) {
  const app = createAgentApp({ entry: ENTRY, manager, config: CONFIG, log: LOG });
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      const rpc = (method, params) =>
        fetch(base + "/", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
      resolve({ base, rpc, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

test("a cancelled turn answers the send with cancellation, not a model failure", async () => {
  // The shape the dsh adapter produces when a cancel lands mid-turn: the turn
  // throws the empty-output error (-32005) because the runtime went idle with
  // no text. The manager reports the cancel; the harness reports the empty turn.
  let cancelled = false;
  const manager = {
    isPaused: () => false,
    turn: async () => {
      // Wait until the test cancels, then fail the way dsh does.
      while (!cancelled) await new Promise((r) => setTimeout(r, 5));
      throw Object.assign(new Error("turn ended without any assistant output (model unavailable or refused)"), { code: -32005 });
    },
    cancelTurn: async () => { cancelled = true; return { ok: true, stopped: "cancelled" }; },
  };
  const h = await serve(manager);
  try {
    const sendP = h.rpc("message/send", { task_id: "t-race", message: { role: "user", context_id: "c1", parts: [{ kind: "text", text: "hi" }] } });
    await new Promise((r) => setTimeout(r, 80));
    const cancel = await h.rpc("tasks/cancel", { task_id: "t-race" });
    assert.equal(cancel.body?.result?.state, "cancelled", "precondition: the cancel settled the task");

    const send = await sendP;
    const err = send.body?.error;
    assert.ok(!err, `a cancelled turn must not answer with a failure, got ${JSON.stringify(err)}`);
    assert.equal(send.body?.result?.task_id, "t-race", "the answer still names the task it settled");

    const after = await h.rpc("tasks/get", { task_id: "t-race" });
    assert.equal(after.body?.result?.state, "cancelled", "query and answer must agree");
  } finally { await h.close(); }
});

test("a genuine model failure still answers with its own error (no over-reach)", async () => {
  // The other side of the same branch: nothing cancelled, the turn produced no
  // text — that IS a failure and must keep reporting as one.
  const manager = {
    isPaused: () => false,
    turn: async () => {
      throw Object.assign(new Error("turn ended without any assistant output (model unavailable or refused)"), { code: -32005 });
    },
    cancelTurn: async () => ({ ok: true, stopped: "not-running" }),
  };
  const h = await serve(manager);
  try {
    const send = await h.rpc("message/send", { task_id: "t-plain", message: { role: "user", context_id: "c2", parts: [{ kind: "text", text: "hi" }] } });
    assert.equal(send.body?.error?.code, -32005, "an uncancelled empty turn stays a model failure");
  } finally { await h.close(); }
});

test("the adapter reports a caller-stopped turn as cancelled, not as an empty failure", async () => {
  // The layer BELOW the a2a face: the runtime goes idle with no text after a
  // cancel. Only the adapter knows a cancel was requested, so this is where the
  // intent flag has to live — the empty-idle shape is otherwise identical to a
  // model that produced nothing.
  const { DshHarnessAdapter } = await import("../agent-runner/harness/dsh.js");
  // Same fake-client shape the ask-lane tests use: a push queue the adapter
  // pumps. The prompt parks (never resolves) so the cancel is what settles it.
  const queue = [];
  let listeners = [];
  let emit;
  const client = {
    start() {},
    async initialize() { return { ok: true }; },
    async request(m) {
      if (m === "session/cancel") setTimeout(() => emit({ method: "session.status", params: { sessionId: "s1", status: "idle" } }), 5);
      return { accepted: true };
    },
    subscribe() {
      emit = (n) => { queue.push(n); const w = listeners; listeners = []; for (const r of w) r(); };
      return { next: async () => { for (;;) { const n = queue.shift(); if (n) return n; await new Promise((r) => listeners.push(r)); } } };
    },
    async prompt() { return "m1"; }, // never speaks, never idles on its own
    async stop() {},
  };
  const adapter = new DshHarnessAdapter({
    key: "a", spawnSpec: { profile: "p", patchPaths: [], cwd: "/tmp", env: {}, provider: "x", model: "y", presetId: null },
    clientFactory: () => client, log: { log() {}, warn() {}, error() {} }, turnTimeoutMs: 60_000, askGraceMs: 5_000,
  });
  await adapter.start();
  const turn = adapter.turn("s1", "hi", {});
  await new Promise((r) => setTimeout(r, 20));
  adapter.markCancelRequested("s1");
  await adapter.request("session/cancel", { sessionId: "s1" });
  const out = await turn;
  assert.equal(out.cancelled, true, "a stopped turn resolves as cancelled");
  assert.equal(out.text, "");
});
