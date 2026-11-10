// chat finishTurn observe-tap 集成测试（add-platform-guaranteed-capture 任务 2）。
//
// 用最小 ctx 直接驱动 server/dsh-events.js 的 attachDshEvents().finishTurn
// （定义体载体），断言每回合收尾恰有一条 lane=chat 的 turn_outcome 落
// fd-memory /observe；error/aborted 照实；CELL_MEMORY_OBSERVE_TAP=0 零请求；
// done 广播等既有输出与 tap 开关无关（逐字节不变）；runtime-bindings 式委托
// 包装层经定义体 tap 恰报一次（双载体不双报）。
//
// dsh-events 调 observeTurnTap 时不传 env/fetchImpl（走 process.env + 全局
// fetch），所以这里起真本地 HTTP server 当 /admin/mint + /observe，无外网。

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachDshEvents } from "../server/dsh-events.js";
import { resetObserveTapTokenCache } from "../server/observe-tap.js";

// ── 本地 memory 替身 ─────────────────────────────────────────────────────────

function startMemoryServer({ mintStatus = 200, observeStatus = 202 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body });
      if (req.url === "/admin/mint") {
        if (mintStatus !== 200) { res.writeHead(mintStatus); res.end("{}"); return; }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: "person-tok" }));
        return;
      }
      if (req.url === "/observe") {
        if (observeStatus !== 202) { res.writeHead(observeStatus); res.end("{}"); return; }
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ page: { path: "observe/x" } }));
        return;
      }
      res.writeHead(404); res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

const waitFor = async (fn, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
};

// ── env 治理：tap 读 process.env，逐键存取 ───────────────────────────────────

const ENV_KEYS = ["CELL_MEMORY_ENABLED", "CELL_MEMORY_URL", "CELL_MEMORY_PLATFORM_TOKEN", "CELL_MEMORY_DATA", "CELL_MEMORY_OBSERVE_TAP"];
let savedEnv;
let mem;
let dataDir;

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  mem = await startMemoryServer();
  process.env.CELL_MEMORY_ENABLED = "1";
  process.env.CELL_MEMORY_URL = mem.url;
  process.env.CELL_MEMORY_PLATFORM_TOKEN = "plat";
  dataDir = mkdtempSync(join(tmpdir(), "yongyi-tap-chat-"));
  process.env.CELL_MEMORY_DATA = dataDir;
  delete process.env.CELL_MEMORY_OBSERVE_TAP;
  resetObserveTapTokenCache();
});

afterEach(async () => {
  // 让在途的 fire-and-forget 链（铸造/投递）先落地，再关替身与恢复 env。
  await new Promise((r) => setTimeout(r, 30));
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetObserveTapTokenCache();
  rmSync(dataDir, { recursive: true, force: true });
  await new Promise((r) => mem.server.close(r));
});

// ── 最小 ctx：finishTurn 只摸这些 ────────────────────────────────────────────

function buildCtx({ sessionId = "sess-1", agentId = "agt-1", user = "owner@x", reply = "回答正文第一段回答正文第二段" } = {}) {
  const ctx = {
    dshSessionId: sessionId,
    currentAgentId: agentId,
    turnStateBySession: new Map(),
    turnBuffers: new Map(),
    turnBufferFor: (sid) => ctx.turnBuffers.get(sid) ?? null,
    resetTurnBuffer: (sid) => ctx.turnBuffers.delete(sid),
    sent: [],
    sendToViewers: (sid, data) => ctx.sent.push({ sid, data }),
    broadcastSessionsCount: 0,
    broadcastSessions: async () => { ctx.broadcastSessionsCount += 1; },
    idleCount: 0,
    onRuntimeIdle: () => { ctx.idleCount += 1; },
  };
  ctx.T = {
    isStreaming: true,
    origin: { user, sessionId },
    startedAt: Date.now() - 1000,
    error: null,
    usage: { inputTokens: 5, outputTokens: 7 },
    toolNames: new Map(),
    blocks: [],
    streamedText: false,
  };
  ctx.turnStateBySession.set(sessionId, ctx.T);
  // 回放缓冲（context.js 同构）：text 增量 + 工具输出 + 思考流，tap 只许取 text。
  ctx.turnBuffers.set(sessionId, {
    events: [
      { type: "agent_start" },
      { type: "text", delta: reply },
      { type: "tool_end", result: "RAW TOOL OUTPUT" },
      { type: "thinking", delta: "reasoning should not leak" },
    ],
    bytes: 128,
    overflow: false,
  });
  return ctx;
}

const observeBodies = () =>
  mem.requests
    .filter((r) => r.url === "/observe")
    .map((r) => JSON.parse(r.body));

// ── 测试 ─────────────────────────────────────────────────────────────────────

test("正常回合：finishTurn 落一条 lane=chat 的 turn_outcome，形状逐字段符合", async () => {
  const ctx = buildCtx();
  attachDshEvents(ctx);
  ctx.finishTurn(undefined, "sess-1");

  assert.equal(await waitFor(() => mem.requests.some((r) => r.url === "/observe")), true, "/observe 收到事件");
  const events = observeBodies();
  assert.equal(events.length, 1, "恰一条（回合收尾单点，无重复）");
  const ev = events[0];
  assert.equal(ev.type, "turn_outcome");
  assert.equal(ev.harness, "yizuo");
  assert.equal(ev.project, undefined, "chat 落 owner default，无 project 键");
  assert.equal(ev.title, "sess-1", "origin 无用户原文，title 以 sessionId 缺省");
  assert.ok(ev.body.includes("回答正文第一段"), "body=final text 摘要（回放缓冲 text 增量）");
  assert.ok(!ev.body.includes("RAW TOOL OUTPUT"), "不落工具输出");
  assert.ok(!ev.body.includes("reasoning"), "不落思考流");
  assert.equal(ev.subject, "agt-1");
  assert.equal(ev.metadata.lane, "chat");
  assert.equal(ev.metadata.sessionId, "sess-1");
  assert.equal(ev.metadata.agentId, "agt-1");
  assert.equal(ev.metadata.outcome, "ok", "idle 路径无显式 outcome 且无 error → ok");
  assert.ok(Math.abs(ev.metadata.durationMs - 1000) < 500, "durationMs 自 startedAt 起算");
  assert.ok(typeof ev.idempotency_key === "string" && ev.idempotency_key.length >= 32);
  // 归属：owner person 令牌铸造（namespace=u/<email>）+ person 令牌投递。
  const mint = mem.requests.find((r) => r.url === "/admin/mint");
  assert.ok(mint, "owner 令牌已铸造");
  assert.equal(JSON.parse(mint.body).namespace, "u/owner@x");
  assert.ok(mem.requests.find((r) => r.url === "/observe").headers.authorization.endsWith("person-tok"));
});

test("既有输出不变：done 广播/usage 透传/buffer 重置/sessions 刷新/idle 与 tap 开关无关", async () => {
  // tap 开。
  const on = buildCtx();
  attachDshEvents(on);
  on.finishTurn(undefined, "sess-1");
  // tap 关。
  process.env.CELL_MEMORY_OBSERVE_TAP = "0";
  const off = buildCtx();
  attachDshEvents(off);
  off.finishTurn(undefined, "sess-1");

  const doneOn = on.sent.filter((s) => s.data.type === "done");
  const doneOff = off.sent.filter((s) => s.data.type === "done");
  assert.deepEqual(doneOn, [{ sid: "sess-1", data: { type: "done", usage: { inputTokens: 5, outputTokens: 7 } } }]);
  assert.deepEqual(doneOn, doneOff, "done 广播逐字节等同（tap 开关无关）");
  assert.deepEqual(on.sent, off.sent, "全部 viewer 广播逐字节等同");
  assert.equal(on.broadcastSessionsCount, 1);
  assert.equal(on.idleCount, 1);
  assert.equal(on.turnBuffers.has("sess-1"), false, "resetTurnBuffer 照常");
  assert.equal(on.turnStateBySession.has("sess-1"), false, "turn state 照常清理");
  assert.equal(on.T.origin, null, "origin 照常重置");
  assert.equal(on.T.usage, null);
});

test("error 路径：T.error 兜底 outcome=error；显式 outcome 照实透传（aborted）", async () => {
  const errCtx = buildCtx();
  attachDshEvents(errCtx);
  errCtx.T.error = "LLM request failed";
  errCtx.finishTurn(undefined, "sess-1"); // idle 路径：outcome 缺省，由 T.error 兜底
  assert.equal(await waitFor(() => observeBodies().length >= 1), true);
  assert.equal(observeBodies()[0].metadata.outcome, "error");

  const abortCtx = buildCtx();
  attachDshEvents(abortCtx);
  abortCtx.finishTurn("aborted", "sess-1"); // stop 路径（agent-session/ws）显式传 aborted
  assert.equal(await waitFor(() => observeBodies().length >= 2), true);
  assert.equal(observeBodies()[1].metadata.outcome, "aborted");
});

test("回滚杆：CELL_MEMORY_OBSERVE_TAP=0 → 零请求，回合输出照常", async () => {
  process.env.CELL_MEMORY_OBSERVE_TAP = "0";
  const ctx = buildCtx();
  attachDshEvents(ctx);
  ctx.finishTurn(undefined, "sess-1");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mem.requests.length, 0, "零请求（连铸造都没有）");
  assert.deepEqual(
    ctx.sent.filter((s) => s.data.type === "done"),
    [{ sid: "sess-1", data: { type: "done", usage: { inputTokens: 5, outputTokens: 7 } } }],
  );
  assert.equal(ctx.broadcastSessionsCount, 1);
});

test("失败即丢：mint 5xx → 回合照常完成，无重试无抛错", async () => {
  mem.server.close(); // 换一个铸不出的替身
  mem = await startMemoryServer({ mintStatus: 500 });
  process.env.CELL_MEMORY_URL = mem.url;
  const ctx = buildCtx();
  attachDshEvents(ctx);
  assert.doesNotThrow(() => ctx.finishTurn(undefined, "sess-1"));
  assert.deepEqual(
    ctx.sent.filter((s) => s.data.type === "done"),
    [{ sid: "sess-1", data: { type: "done", usage: { inputTokens: 5, outputTokens: 7 } } }],
  );
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!mem.requests.some((r) => r.url === "/observe"), "铸造失败 → 无投递");
});

test("双载体不双报：runtime-bindings 式委托包装经定义体 tap 恰报一次", async () => {
  const ctx = buildCtx();
  attachDshEvents(ctx);
  // 与 server/runtime-bindings.js:189-194 同构：捕获定义体、原参透传、
  // 仅追加 queueMicrotask 后续。委托语义下定义体 tap 必经，包装无需第二处。
  const originalFinishTurn = ctx.finishTurn;
  ctx.finishTurn = (outcome, sid) => {
    const result = originalFinishTurn?.(outcome, sid);
    queueMicrotask(() => {});
    return result;
  };
  ctx.finishTurn(undefined, "sess-1"); // 经包装层关闭
  ctx.finishTurn(undefined, "sess-1"); // 二次调用：无 open turn → no-op
  assert.equal(await waitFor(() => observeBodies().length >= 1), true);
  await new Promise((r) => setTimeout(r, 30)); // 等可能的迟到重复，再钉死「恰一条」
  assert.equal(observeBodies().length, 1, "委托包装 + 重复关闭 → 恰一条");
  assert.equal(ctx.sent.filter((s) => s.data.type === "done").length, 1);
});

test("无 open turn：finishTurn no-op，零请求零广播", async () => {
  const ctx = buildCtx();
  attachDshEvents(ctx);
  ctx.T.isStreaming = false; // per-turn 幂等门槛
  ctx.finishTurn(undefined, "sess-1");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mem.requests.length, 0);
  assert.equal(ctx.sent.length, 0);
});
