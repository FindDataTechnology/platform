// observe-tap bot 面集成测（add-platform-guaranteed-capture 任务 3）：真起
// handleMessage/runTurn harness（telegram 适配器 + mock dsh bridge + 全局
// fetch 桩），断言回合结算向 /observe 报 lane=bot 事件（形状逐项）、失败与
// 硬超时同样落底、回复门禁扣住的回合 outcome 照实（门禁在投递层）、回滚杆
// 零请求、投递链路输出不变。无网络。

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// BOTS_TURN_TIMEOUT_MS 在 bots.js 模块加载时读定：先设短死线再动态导入，
// abort 分支（collector 硬超时）才可在测内触发。
process.env.BOTS_TURN_TIMEOUT_MS = "200";
process.env.PUBLIC_BASE_URL = "http://test.local"; // telegram 长轮询只在无公网 URL 时启动
const { handleMessage, initBots, sessionIdFor } = await import("../server/bots.js");
const { resetObserveTapTokenCache } = await import("../server/observe-tap.js");

const REAL_FETCH = globalThis.fetch;
const ENV_KEYS = ["CELL_MEMORY_ENABLED", "CELL_MEMORY_URL", "CELL_MEMORY_PLATFORM_TOKEN", "CELL_MEMORY_OBSERVE_TAP"];

const BOT_ID = "bot-tap-1";
let dataDir = null;
let posts = []; // memory 面收包（mint + observe）
let tgSends = []; // telegram sendMessage 投递面

function botRow(over = {}) {
  return {
    id: BOT_ID,
    type: "telegram",
    name: "TapBot",
    enabled: true,
    secret: "s3cret",
    credentials: { token: "tg-token" },
    ownerEmail: "owner@x",
    persona: null,
    allowTools: false,
    zhiRoomId: null,
    effort: null,
    contextBudget: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function makeCtx(row, promptImpl) {
  const collectors = new Map();
  const ctx = {
    db: {
      isDbReady: () => true,
      listBots: () => [row],
      upsertBotChat() {},
      getCustomSkill: () => null,
    },
    dshBridge: { isReady: () => true, prompt: promptImpl },
    sessionCollectors: collectors,
    setStreaming() {},
  };
  initBots(ctx);
  return ctx;
}

// 全局 fetch 桩：既当 personTokenFor 的 /admin/mint 与 /observe 收包器，又当
// telegram sendMessage 投递记录器。bots.js 生产调用不传 fetchImpl，tap 全链
// 走全局 fetch——一根桩覆盖捕获与投递两面。
function installFetch() {
  posts = [];
  tgSends = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/admin/mint")) {
      posts.push({ url: u, init });
      return { ok: true, status: 200, json: async () => ({ token: "person-tok" }) };
    }
    if (u.endsWith("/observe")) {
      posts.push({ url: u, init });
      return { ok: true, status: 202, json: async () => ({ page: { path: "x" } }) };
    }
    if (u.includes("api.telegram.org")) {
      tgSends.push({ url: u, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
}

beforeEach(() => {
  installFetch();
  dataDir = mkdtempSync(join(tmpdir(), "yongyi-tap-bot-"));
  process.env.CELL_MEMORY_ENABLED = "1";
  process.env.CELL_MEMORY_URL = "http://memory.test";
  process.env.CELL_MEMORY_PLATFORM_TOKEN = "plat";
  process.env.CELL_MEMORY_DATA = dataDir;
  delete process.env.CELL_MEMORY_OBSERVE_TAP;
});

afterEach(() => {
  resetObserveTapTokenCache();
  globalThis.fetch = REAL_FETCH;
  for (const k of ENV_KEYS) delete process.env[k];
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  }
});

const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function deliverCollector(ctx, sessionId, notifs) {
  const c = ctx.sessionCollectors.get(sessionId);
  if (!c) throw new Error("collector not registered");
  for (const n of notifs) c(n);
}

const finalText = (t) => ({
  method: "session.event",
  params: { event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: t }] } } } },
});
const toolCall = (name) => ({
  method: "session.event",
  params: { event: { type: "tool/call", data: { name } } },
});
const idle = { method: "session.status", params: { status: "idle" } };
const llmErrorFrame = (msg) => ({
  method: "platform/stream",
  params: { frame: { chunk: { type: "finish", reason: { kind: "error", failure: { message: msg } } } } },
});

test("成功回合：/observe 收 lane=bot 事件（agentId=botId、sessionId=chatKey、ok、正文原料）且投递链路不变", async () => {
  const chatKey = "chat-ok-1";
  let promptSid = null;
  const ctx = makeCtx(botRow(), async (sid) => {
    promptSid = sid;
    deliverCollector(ctx, sid, [finalText("final answer"), idle]);
  });

  await handleMessage(BOT_ID, { chatKey, senderName: "alice", text: "hello bot" });
  await flush();

  // 投递链路不变：sendMessage 照常收到 final text
  assert.equal(tgSends.length, 1);
  assert.equal(tgSends[0].body.chat_id, chatKey);
  assert.equal(tgSends[0].body.text, "final answer");

  // 回合跑在派生 dsh 会话上（harness 自身健全性）
  assert.equal(promptSid, sessionIdFor(BOT_ID, chatKey));

  // owner person 令牌铸造 + observe 投递
  assert.ok(posts.some((p) => p.url.endsWith("/admin/mint")), "owner person token minted");
  const observe = posts.find((p) => p.url.endsWith("/observe"));
  assert.ok(observe, "/observe 被调用");
  assert.ok(observe.init.headers.authorization.endsWith("person-tok"));

  const body = JSON.parse(observe.init.body);
  assert.equal(body.type, "turn_outcome");
  assert.equal(body.harness, "yizuo");
  assert.equal(body.project, undefined, "bot 无 roomId → 无 project 键（落 owner default）");
  assert.equal(body.metadata.lane, "bot");
  assert.equal(body.metadata.sessionId, chatKey, "sessionId=chatKey");
  assert.equal(body.metadata.agentId, BOT_ID, "agentId=botId");
  assert.equal(body.metadata.outcome, "ok");
  assert.ok(Number.isFinite(body.metadata.durationMs) && body.metadata.durationMs >= 0);
  assert.equal(body.title, "hello bot", "title=入站 text（未超 80 原样）");
  assert.equal(body.body, "final answer", "body=assistant final text");
  assert.ok(body.idempotency_key.length >= 32);
});

test("prompt 抛错：outcome=error，用户仍收到 sorry 兜底回复，body 走缺省过程叙事", async () => {
  const chatKey = "chat-prompt-throw";
  // makeCtx installs the bot bridge as a module-level side effect; the returned
  // handle is not read here (handleMessage resolves it from module state).
  makeCtx(botRow(), async () => {
    throw new Error("bridge exploded");
  });

  await handleMessage(BOT_ID, { chatKey, senderName: "a", text: "hi" });
  await flush();

  assert.equal(tgSends.length, 1);
  assert.equal(tgSends[0].body.text, "Sorry — I could not complete that request.");
  const body = JSON.parse(posts.find((p) => p.url.endsWith("/observe")).init.body);
  assert.equal(body.metadata.outcome, "error");
  assert.match(body.body, /回合收尾/, "无 final text → 缺省过程叙事（fd-memory body_required 的兜底）");
});

test("LLM 错误帧（platform/stream finish error）：result.error → outcome=error", async () => {
  const chatKey = "chat-llm-err";
  const ctx = makeCtx(botRow(), async (sid) => {
    deliverCollector(ctx, sid, [llmErrorFrame("LLM down"), idle]);
  });

  await handleMessage(BOT_ID, { chatKey, senderName: "a", text: "hi" });
  await flush();

  assert.equal(tgSends[0].body.text, "Sorry — LLM down");
  const body = JSON.parse(posts.find((p) => p.url.endsWith("/observe")).init.body);
  assert.equal(body.metadata.outcome, "error");
});

test("硬超时（回合被截断、无 LLM 结论）：outcome=aborted", async () => {
  const chatKey = "chat-aborted";
  makeCtx(botRow(), async () => {
    // prompt 落地但回合永不 idle：collector 200ms 硬超时拒绝
  });

  await handleMessage(BOT_ID, { chatKey, senderName: "a", text: "hi" });
  await flush(80);

  assert.equal(tgSends[0].body.text, "Sorry — I could not complete that request.");
  const body = JSON.parse(posts.find((p) => p.url.endsWith("/observe")).init.body);
  assert.equal(body.metadata.outcome, "aborted");
});

test("回复门禁扣住（usedTools 且 no-tools 姿态）：outcome=ok（门禁在回合完成后的投递层）且投递为 withhold 文案", async () => {
  const chatKey = "chat-gate";
  const ctx = makeCtx(botRow(), async (sid) => {
    deliverCollector(ctx, sid, [toolCall("search_web"), finalText("tool answer"), idle]);
  });

  await handleMessage(BOT_ID, { chatKey, senderName: "a", text: "hi" });
  await flush();

  assert.equal(tgSends[0].body.text, "Sorry — I cannot answer that from this channel.");
  const body = JSON.parse(posts.find((p) => p.url.endsWith("/observe")).init.body);
  assert.equal(body.metadata.outcome, "ok", "被门禁扣住的回合同样落底，outcome 照实=回合本身完成");
});

test("回滚杆 CELL_MEMORY_OBSERVE_TAP=0：零 mint 零 observe，投递不变", async () => {
  process.env.CELL_MEMORY_OBSERVE_TAP = "0";
  const chatKey = "chat-rollback";
  const ctx = makeCtx(botRow(), async (sid) => {
    deliverCollector(ctx, sid, [finalText("answer"), idle]);
  });

  await handleMessage(BOT_ID, { chatKey, senderName: "a", text: "hi" });
  await flush();

  assert.equal(posts.length, 0, "零请求（连铸造都没有）");
  assert.equal(tgSends[0].body.text, "answer", "投递链路逐字节不变");
});

test("legacy 行无 owner：tap 静默丢弃（fail-open），回合照常回复", async () => {
  const chatKey = "chat-no-owner";
  const ctx = makeCtx(botRow({ ownerEmail: null }), async (sid) => {
    deliverCollector(ctx, sid, [finalText("answer"), idle]);
  });

  await handleMessage(BOT_ID, { chatKey, senderName: "a", text: "hi" });
  await flush();

  assert.equal(posts.length, 0, "owner 缺失 → 零请求");
  assert.equal(tgSends[0].body.text, "answer");
});
