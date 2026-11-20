// 智语 room-router tap 集成测（add-platform-guaranteed-capture 任务 4.2）：
// mock callAgent/store 驱动 runTurn 三分支（answered/passed/failed），断言
// /observe 收包形状与房间 project 分派（房主根房间名下 project）；隐私镜像
// 断言——全部请求要么是铸造要么带 project，成员个人 default 根零写入，铸造
// namespace 恒为房主（u/host@x）；回滚杆零请求；failure-isolation（记忆不
// 可达回合照常）。room-router 生产路径走缺省 process.env + 全局 fetch，测试
// 在本进程内打桩替换（node --test 每文件独立进程，桩不外溢）。无网络。

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoomRouter } from "../gateway/zhiyu/room-router.js";
import { resetObserveTapTokenCache } from "../server/observe-tap.js";

const SAVED_FETCH = globalThis.fetch;
const ENV_KEYS = [
  "CELL_MEMORY_ENABLED",
  "CELL_MEMORY_URL",
  "CELL_MEMORY_PLATFORM_TOKEN",
  "CELL_MEMORY_DATA",
  "CELL_MEMORY_OBSERVE_TAP",
];
let savedEnv = null;
let dataDir = null;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dataDir = mkdtempSync(join(tmpdir(), "zhiyu-tap-"));
  Object.assign(process.env, {
    CELL_MEMORY_ENABLED: "1",
    CELL_MEMORY_URL: "http://memory.test",
    CELL_MEMORY_PLATFORM_TOKEN: "plat",
    CELL_MEMORY_DATA: dataDir,
  });
  delete process.env.CELL_MEMORY_OBSERVE_TAP;
});

afterEach(() => {
  globalThis.fetch = SAVED_FETCH;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetObserveTapTokenCache();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = null;
});

// mock fetch：既当 personTokenFor 的 /admin/mint，又当 /observe 收包器。
// 装到 globalThis（room-router 生产路径不传 fetchImpl，SDK 回退全局 fetch）。
function mockMemory({ mintOk = true, observeOk = true } = {}) {
  const posts = [];
  const impl = async (url, init = {}) => {
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
  globalThis.fetch = impl;
  return posts;
}

// 等 fire-and-forget 链（铸造→投递）落袋。
async function waitFor(pred, ms = 1000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, 10));
  }
}

// 最小 room store 形状（runTurn/onHumanMessage 实际触到的面）。
function mockStore({ ownerEmail = "host@x" } = {}) {
  const room = { id: "r1", title: "测试空间", status: "active", ownerEmail, dailyBudgetTurns: null };
  const rows = [];
  return {
    room,
    rows,
    roomGet: (id) => (id === room.id ? room : null),
    membersOf: () => [agentMember()],
    memberFor: () => null,
    messagesAfter: () => [],
    messageAppend: (arg) => {
      const row = { seq: rows.length + 1, ...arg };
      rows.push(row);
      return { row };
    },
    roomConsumeTurnBudget: () => 1,
    roomDayTurnsPeek: () => 0,
  };
}

function agentMember() {
  return { id: "a1", kind: "agent", state: "active", ref: "agent-1", display: "小壹", alias: "", presence: "active" };
}

const host = { id: "m1", ref: "host", display: "房主", kind: "user" };
const observeBodies = (posts) =>
  posts.filter((p) => p.url.endsWith("/observe")).map((p) => JSON.parse(p.init.body));

// 三行为队列：answer / pass / throw —— 一次装配可驱动三分支。
function callAgentQueue(...behaviors) {
  const queue = [...behaviors];
  return async () => {
    const b = queue.shift();
    if (b === "pass") return { text: "「过」" };
    if (b === "throw") throw new Error("模型超时");
    return { text: "记忆由平台担保落底。" };
  };
}

async function trigger(router, content) {
  await router.onHumanMessage({ room: { id: "r1" }, member: host, message: { seq: 1, content } });
}

test("answered：/observe 落房主根房间 project，metadata 形状（lane/agentId/sessionId/outcome=ok），回合产物与 memoryBlock 注入零变化", async () => {
  const posts = mockMemory();
  const store = mockStore();
  let memoryBlockCalls = 0;
  const router = createRoomRouter({
    store,
    effectiveCap: () => 3,
    callAgent: callAgentQueue("answer"),
    memoryBlock: async () => {
      memoryBlockCalls += 1;
      return "";
    },
  });
  await trigger(router, "@小壹 什么是平台担保记忆？");
  const bodies = await waitFor(() => observeBodies(posts).length >= 1 && observeBodies(posts));
  assert.ok(bodies, "/observe 收到一条");
  assert.equal(bodies.length, 1, "一回合恰一条");
  const body = bodies[0];
  assert.equal(body.type, "turn_outcome");
  assert.equal(body.harness, "yizuo");
  assert.equal(body.project, "room-r1", "房主根内房间 project");
  assert.equal(body.metadata.lane, "zhiyu");
  assert.equal(body.metadata.outcome, "ok");
  assert.equal(body.metadata.agentId, "agent-1", "memberRef 实名");
  assert.equal(body.metadata.sessionId, "room:r1:agent-1", "回合 contextId（含 roomId）");
  assert.ok(Number.isFinite(body.metadata.durationMs) && body.metadata.durationMs >= 0);
  assert.equal(body.title, "@小壹 什么是平台担保记忆？");
  assert.equal(body.body, "记忆由平台担保落底。");
  assert.ok(body.idempotency_key.length >= 32, "幂等键自动生成");
  // 纯旁路：回合产物与注入语义照旧
  assert.equal(memoryBlockCalls, 1, "memoryBlock 注入照旧被调");
  assert.ok(
    store.rows.some((r) => r.kind === "agent" && r.content === "记忆由平台担保落底。" && r.meta?.mode === "direct"),
    "agent 行照旧落库"
  );
});

test("passed：metadata.outcome=passed 照实区分（subOutcome 无独立通道，落在 outcome 本位），非空过程叙事 body 落底", async () => {
  const posts = mockMemory();
  const store = mockStore();
  const router = createRoomRouter({ store, effectiveCap: () => 3, callAgent: callAgentQueue("pass") });
  await trigger(router, "大家随便聊聊"); // 无 @ → solicit → 过
  const bodies = await waitFor(() => observeBodies(posts).length >= 1 && observeBodies(posts));
  const body = bodies[0];
  assert.equal(body.project, "room-r1");
  assert.equal(body.metadata.outcome, "passed", "passed 与普通 ok 区分（fd-memory metadata 自由标量）");
  assert.equal(body.body, "「过」", "过=过程叙事；空 body 会被 fd-memory body_required 400 丢弃");
  assert.equal(body.title, "大家随便聊聊");
  assert.ok(store.rows.some((r) => r.kind === "event" && r.meta?.event === "pass"), "pass 事件行照旧");
  assert.ok(!store.rows.some((r) => r.kind === "agent"), "过不落 agent 行（计费纪律不变）");
});

test("failed：metadata.outcome=error，reason 作过程叙事 body，失败事件行照旧", async () => {
  const posts = mockMemory();
  const store = mockStore();
  const router = createRoomRouter({ store, effectiveCap: () => 3, callAgent: callAgentQueue("throw") });
  await trigger(router, "@小壹 再答一次");
  const bodies = await waitFor(() => observeBodies(posts).length >= 1 && observeBodies(posts));
  const body = bodies[0];
  assert.equal(body.project, "room-r1");
  assert.equal(body.metadata.outcome, "error");
  assert.equal(body.body, "模型超时");
  assert.ok(store.rows.some((r) => r.kind === "event" && r.meta?.event === "agent_failed"), "失败事件行照旧");
});

test("隐私镜像：三分支全跑一遍——每条 /observe 都带房间 project（无 project 键的请求为零），铸造 namespace 恒为房主", async () => {
  const posts = mockMemory();
  const router = createRoomRouter({
    store: mockStore(),
    effectiveCap: () => 3,
    callAgent: callAgentQueue("answer", "pass", "throw"),
  });
  await trigger(router, "@小壹 一");
  await trigger(router, "二（广播征询）");
  await trigger(router, "@小壹 三");
  const bodies = await waitFor(() => observeBodies(posts).length >= 3 && observeBodies(posts));
  assert.ok(bodies, "三分支各落一条");
  assert.equal(bodies.length, 3);
  assert.deepEqual(
    bodies.map((b) => b.metadata.outcome).sort(),
    ["error", "ok", "passed"]
  );
  for (const b of bodies) {
    assert.ok(b.project && b.project.startsWith("room-"), `每条都落房间 project（got: ${b.project}）`);
    assert.equal(b.metadata.lane, "zhiyu");
  }
  // 出站全集核对：除铸造外没有任何请求，投递全部带 project——成员个人
  // default 根零写入（隐私镜像断言）。
  assert.ok(posts.every((p) => p.url.endsWith("/admin/mint") || p.url.endsWith("/observe")));
  const mints = posts.filter((p) => p.url.endsWith("/admin/mint"));
  assert.ok(mints.length >= 1);
  for (const m of mints) {
    const req = JSON.parse(m.init.body);
    assert.equal(req.namespace, "u/host@x", "只铸房主令牌——成员个人根零接触");
  }
});

test("回滚杆：CELL_MEMORY_OBSERVE_TAP=0 → 零请求（连铸造都没有），回合产物照旧", async () => {
  const posts = mockMemory();
  process.env.CELL_MEMORY_OBSERVE_TAP = "0";
  const store = mockStore();
  const router = createRoomRouter({ store, effectiveCap: () => 3, callAgent: callAgentQueue("answer") });
  await trigger(router, "@小壹 回滚杆下也要答");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(posts.length, 0, "零请求");
  assert.ok(store.rows.some((r) => r.kind === "agent" && r.content === "记忆由平台担保落底。"), "回合产物照旧");
});

test("failure-isolation：铸造 5xx / 投递 5xx 都不炸回合，落库照常，无重试风暴", async () => {
  const posts1 = mockMemory({ mintOk: false });
  const store1 = mockStore();
  const router1 = createRoomRouter({ store: store1, effectiveCap: () => 3, callAgent: callAgentQueue("answer") });
  await trigger(router1, "@小壹 记忆挂了也要答");
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(store1.rows.some((r) => r.kind === "agent"), "回合照常完成");
  assert.ok(posts1.every((p) => p.url.endsWith("/admin/mint")), "铸造失败即丢，无 observe 投递");

  const posts2 = mockMemory({ observeOk: false });
  const store2 = mockStore();
  const router2 = createRoomRouter({ store: store2, effectiveCap: () => 3, callAgent: callAgentQueue("answer") });
  await trigger(router2, "@小壹 observe 5xx 也照答");
  const bodies = await waitFor(() => observeBodies(posts2).length >= 1 && observeBodies(posts2));
  assert.ok(bodies, "投递尝试发生（失败即丢）");
  assert.ok(store2.rows.some((r) => r.kind === "agent"), "投递失败回合照常");
});
