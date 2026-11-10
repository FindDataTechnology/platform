// observe-tap 单测（add-platform-guaranteed-capture 任务 1.3）：配置三态零请
// 求、事件体形状、截断边界、房间 project 分派、失败即丢。mock fetch 断言收包，
// 无网络。

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeTurnTap, resetObserveTapTokenCache } from "../server/observe-tap.js";

const dirs = [];
afterEach(() => {
  resetObserveTapTokenCache();
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

// 每测试独立 dataRoot：SDK personTokenFor 有磁盘缓存（cell-memory-tokens/），
// 共享目录会让后位测试命中前位测试的令牌（假通过/假失败）。
const BASE_ENV = () => {
  const data = mkdtempSync(join(tmpdir(), "yongyi-tap-"));
  dirs.push(data);
  return {
    CELL_MEMORY_ENABLED: "1",
    CELL_MEMORY_URL: "http://memory.test",
    CELL_MEMORY_PLATFORM_TOKEN: "plat",
    CELL_MEMORY_DATA: data,
  };
};

// mock fetch：既当 personTokenFor 的 /admin/mint，又当 /observe 收包器。
function mockMemory({ mintOk = true, observeOk = true } = {}) {
  const posts = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    posts.push({ url: u, init });
    if (u.endsWith("/admin/mint")) {
      if (!mintOk) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ token: "person-tok" }) };
    }
    if (u.endsWith("/observe")) {
      if (!observeOk) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 202, json: async () => ({ page: { path: "x" } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchImpl, posts };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

test("正常路径：chat 事件形状（harness/lane/metadata/幂等键）且落 default（无 project 键）", async () => {
  const { fetchImpl, posts } = mockMemory();
  observeTurnTap({
    ownerEmail: "u@x", lane: "chat", sessionId: "s1", agentId: "local",
    outcome: "ok", durationMs: 1234.6, title: "用户的问题", body: "回答摘要",
  }, BASE_ENV(), fetchImpl);
  await flush();
  const observe = posts.find((p) => p.url.endsWith("/observe"));
  assert.ok(observe, "/observe 被调用");
  const body = JSON.parse(observe.init.body);
  assert.equal(body.type, "turn_outcome");
  assert.equal(body.harness, "yizuo");
  assert.equal(body.project, undefined, "chat 无 roomId → 无 project 键（落 default）");
  assert.equal(body.metadata.lane, "chat");
  assert.equal(body.metadata.outcome, "ok");
  assert.equal(body.metadata.durationMs, 1235, "durationMs 四舍五入");
  assert.equal(body.metadata.sessionId, "s1");
  assert.ok(body.idempotency_key.length >= 32, "幂等键自动生成");
  assert.ok(observe.init.headers.authorization.endsWith("person-tok"));
});

test("回滚杆：CELL_MEMORY_OBSERVE_TAP=0 → 零请求（连铸造都没有）", async () => {
  const { fetchImpl, posts } = mockMemory();
  observeTurnTap({ ownerEmail: "u@x", lane: "chat", sessionId: "s1", outcome: "ok" },
    { ...BASE_ENV(), CELL_MEMORY_OBSERVE_TAP: "0" }, fetchImpl);
  await flush();
  assert.equal(posts.length, 0);
});

test("配置不全：CELL_MEMORY_ENABLED 缺 → 零请求", async () => {
  const { fetchImpl, posts } = mockMemory();
  const env = BASE_ENV();
  delete env.CELL_MEMORY_ENABLED;
  observeTurnTap({ ownerEmail: "u@x", lane: "bot", sessionId: "c1", outcome: "ok" }, env, fetchImpl);
  await flush();
  assert.equal(posts.length, 0);
});

test("铸造失败：静默丢弃零抛错、零 /observe 调用", async () => {
  const { fetchImpl, posts } = mockMemory({ mintOk: false });
  observeTurnTap({ ownerEmail: "u@x", lane: "bot", sessionId: "c1", outcome: "ok" }, BASE_ENV(), fetchImpl);
  await flush();
  assert.ok(posts.every((p) => p.url.endsWith("/admin/mint")), "只有铸造尝试，无 observe 投递");
});

test("投递失败：fire-and-forget 不抛错（observeOk=false 也不炸调用方）", async () => {
  const { fetchImpl } = mockMemory({ observeOk: false });
  assert.doesNotThrow(() => {
    observeTurnTap({ ownerEmail: "u@x", lane: "zhiyu", sessionId: "ctx1", agentId: "m1",
      outcome: "failed", roomId: "room-9", title: "触发消息", body: "x".repeat(5000) },
      BASE_ENV(), fetchImpl);
  });
});

test("智语房间：project=room-<id> 分派 + 截断纪律（title 80 / body 4000 封顶）", async () => {
  const { fetchImpl, posts } = mockMemory();
  const longTitle = "触".repeat(200);
  const longBody = "答".repeat(5000);
  observeTurnTap({
    ownerEmail: "host@x", lane: "zhiyu", sessionId: "ctx-1", agentId: "member/ref-1",
    outcome: "answered", roomId: "room-9", title: longTitle, body: longBody,
  }, BASE_ENV(), fetchImpl);
  await flush();
  const observe = posts.find((p) => p.url.endsWith("/observe"));
  const body = JSON.parse(observe.init.body);
  assert.equal(body.project, "room-room-9");
  assert.equal(body.title.length, 81, "80 字符 + 省略号");
  assert.equal(body.body.length, 4001, "4000 字符 + 省略号");
  assert.equal(body.metadata.lane, "zhiyu");
  assert.ok(body.metadata.agentId);
});

test("outcome 缺省 ok；字段缺失不炸（session 缺失直接丢弃）", async () => {
  const { fetchImpl, posts } = mockMemory();
  observeTurnTap({ ownerEmail: "u@x", lane: "chat" }, BASE_ENV(), fetchImpl);
  await flush();
  assert.equal(posts.find((p) => p.url.endsWith("/observe")), undefined, "无 sessionId → 丢弃");

  const { fetchImpl: f2, posts: p2 } = mockMemory();
  observeTurnTap({ ownerEmail: "u@x", lane: "chat", sessionId: "s2" }, BASE_ENV(), f2);
  await flush();
  const body = JSON.parse(p2.find((p) => p.url.endsWith("/observe")).init.body);
  assert.equal(body.metadata.outcome, "ok");
  assert.ok(body.title.includes("回合收尾"), "无 title 时用缺省标题");
});
