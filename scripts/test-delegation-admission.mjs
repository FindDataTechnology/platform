#!/usr/bin/env node
// ── fix-delegated-round-admission ───────────────────────────────────────────
//
// 两条被判据钉住的修复：
//   ① 对话发起的委托轮以 humanPriority 落库（两条创建路径：persona / a2a）；
//   ② queueHealth 的在链判定认池的认领，池内等待不再被判孤悬（且真孤悬仍要能红）。
//
// Run: node --test scripts/test-delegation-admission.mjs

import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, after } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "deleg-admission-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");
process.env.CRON_STORAGE_PATH = path.join(tmpRoot, "cron");
process.env.AGENTS_CONFIG_URL = "";
// 周期刷新关掉：否则 catalog 会挂一个 60s 的 timer 把测试进程留住
process.env.CATALOG_REFRESH_SECS = "0";
// catalog 的本地条目读 cwd 下的 agents.json（bundledJson："cwd 副本优先"）。
// 把一条 a2a 条目钉进临时目录再 chdir，a2a 那条创建路径才能被真跑一遍，
// 而不是只测 persona 那条。node --test 每个文件独立进程，chdir 不牵连别人。
writeFileSync(
  path.join(tmpRoot, "agents.json"),
  JSON.stringify({
    agents: [
      {
        id: "svc-a2a",
        type: "agent-remote",
        mode: "a2a",
        name: "远端服务",
        url: "https://example.test/agent/svc/",
      },
    ],
    apps: [],
  }),
);
process.chdir(tmpRoot);

const engine = await import("../task-engine.js");
const catalog = await import("../catalog.js");
const { registerDelegationRoutes } = await import("../server/routes/delegation.js");

await catalog.initCatalog({ broadcast: () => {} });

after(() => rmSync(tmpRoot, { recursive: true, force: true }));

// ── ① 池认领计入在链判定 ─────────────────────────────────────────────────────

// 孤悬判定有两次评估的去抖（`orphanCandidates`），所以"当前口径"必须读第二次。
function healthNow() {
  engine.queueHealth({ budgetOf: () => 60_000 });
  return engine.queueHealth({ budgetOf: () => 60_000 });
}

async function freshEngine() {
  await engine.initTaskEngine({
    broadcast: () => {},
    isBusy: () => false,
    runTurn: async () => ({ ok: true }),
  });
}

test("池已认领的排队任务不再计为孤悬，也不再把健康快照拉进降级", async () => {
  await freshEngine();
  const claimed = new Set();
  // 池的语义：接单（返回 true）⇒ 引擎不再把它挂上串行链，它只在池的 waiting 里。
  const dispatcher = (t) => {
    if (!t) return false;
    claimed.add(t.id);
    return true;
  };
  dispatcher.claims = (id) => claimed.has(id);
  engine.setSlotDispatcher(dispatcher);

  // 基线：先读两次把去抖状态铺平，之后所有断言都是相对于基线的增量。
  const base = healthNow().orphaned;

  const created = engine.createManualTask({
    prompt: "p1",
    persona: "persona-one",
    humanPriority: true,
  });
  assert.equal(engine.getRecord(created.id).state === "running", false, "被池接单的轮不该在串行链上开跑");
  assert.equal(engine.getRecord(created.id).state, "queued");

  const h = healthNow();
  assert.equal(h.orphaned, base, "池已认领 ⇒ 不计孤悬（新增的一轮不应抬高计数）");
  assert.equal(h.degraded, false, "池内等待不得把健康快照拉进降级");
});

test("既不在链上、也未被池认领的排队任务仍判孤悬（放宽必须双向）", async () => {
  await freshEngine();
  const claimed = new Set();
  // 这个派发器故意"接单但 claims 不认"：它复现的正是修复前的那种观测
  // ——任务离开串行链、池又不承认认领，探针必须还能点破它。
  const dispatcher = (t) => {
    if (!t) return false;
    if (t.preset === "persona-liar") return true; // 接了，但不说
    claimed.add(t.id);
    return true;
  };
  dispatcher.claims = (id) => claimed.has(id);
  engine.setSlotDispatcher(dispatcher);

  const base = healthNow().orphaned;
  engine.createManualTask({ prompt: "p2", persona: "persona-liar" });

  const h = healthNow();
  assert.ok(h.orphaned > base, `未认领的离链排队任务必须被点破（实际 ${h.orphaned} vs 基线 ${base}）`);
  assert.equal(h.degraded, true, "真孤悬仍要判降级——否则等于把探针弄瞎");
});

test("没有执行池时判定与引入本要求之前一致", async () => {
  await freshEngine();
  const claimed = new Set();
  const dispatcher = (t) => {
    if (!t) return false;
    claimed.add(t.id);
    return true;
  };
  dispatcher.claims = (id) => claimed.has(id);
  engine.setSlotDispatcher(dispatcher);
  const created = engine.createManualTask({ prompt: "p3", persona: "persona-three" });
  const base = healthNow().orphaned;

  // 池被摘掉（cap=0 的部署形态）：认领来源消失，这条离链任务必须重新算作孤悬。
  engine.setSlotDispatcher(null);
  const h = healthNow();
  assert.ok(h.orphaned >= base + 1, "没有池认领来源时，同一条离链任务仍要计入孤悬");
  assert.equal(engine.getRecord(created.id).state, "queued");
});

// ── ② 委托轮按人触发登记 ─────────────────────────────────────────────────────

function routeApp(currentPreset = "standard") {
  const app = express();
  app.use(express.json());
  const ctx = {
    app,
    currentPreset,
    broadcast: () => {},
    sessionVersion: 0,
    sessionCollectors: new Map(),
  };
  registerDelegationRoutes(ctx);
  return app;
}

function request(app, { method = "GET", path: p = "/api/delegation/tasks", body } = {}) {
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.unref();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const payload = body === undefined ? undefined : JSON.stringify(body);
      import("node:http").then(({ request: httpRequest }) => {
        const r = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: p,
            method,
            headers: payload
              ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
              : {},
          },
          (res) => {
            let out = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (out += c));
            res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(out || "{}") }));
          },
        );
        r.on("error", reject);
        if (payload) r.write(payload);
        r.end();
      });
    });
  });
}

test("persona 委托：落库带 humanPriority，且其它字段不变", async () => {
  await freshEngine();
  const app = routeApp();
  const res = await request(app, {
    method: "POST",
    path: "/api/delegation/tasks",
    body: { persona: "sta-clerk", prompt: "出一份进度快照" },
  });
  assert.equal(res.status, 201);

  const rec = engine.getRecord(res.body.task.id);
  assert.ok(rec, "任务记录存在");
  assert.equal(rec.humanPriority, true, "对话发起的委托轮必须按人触发登记");
  // 标记不得顺带改语义
  assert.equal(rec.trigger, "manual");
  assert.equal(rec.status, "manual");
  assert.equal(rec.targetType, "persona");
  assert.equal(rec.preset, "sta-clerk");
});

test("a2a 委托：同一条纪律（第二条创建路径不漏）", async () => {
  await freshEngine();
  const app = routeApp();
  const res = await request(app, {
    method: "POST",
    path: "/api/delegation/tasks",
    body: { agent: "svc-a2a", prompt: "远端跑一轮" },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  const rec = engine.getRecord(res.body.task.id);
  assert.equal(rec.humanPriority, true, "a2a 委托轮同样要按人触发登记");
  assert.equal(rec.targetType, "a2a");
  assert.equal(rec.preset, "svc-a2a");
});

// ── ③ 同一身份两种拼法：入口要折成运行期 roster id ───────────────────────────
//
// 目录/预设 API 的 id 是 `user.preset-7`（点号），运行期 roster 只允许 [a-z0-9-]，
// 所以真能解析的是 `user-preset-7`。集群派发那条路折过，delegate_task 这条没折，
// 于是落库点号形式、执行期 `Unknown agent preset`（2026-11-12 实测 gg928n）。

test("persona 委托：点号形式的预设 id 折成运行期 roster id 再落库", async () => {
  await freshEngine();
  const app = routeApp();
  const res = await request(app, {
    method: "POST",
    path: "/api/delegation/tasks",
    body: { persona: "user.preset-7", prompt: "点号形式" },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const rec = engine.getRecord(res.body.task.id);
  assert.equal(rec.preset, "user-preset-7", "落库必须是运行期能解析的 roster id");
  assert.equal(rec.humanPriority, true);
});

test("自派拒绝对两种拼法都生效（折完再比）", async () => {
  await freshEngine();
  const app = routeApp("user-preset-7");
  const res = await request(app, {
    method: "POST",
    path: "/api/delegation/tasks",
    body: { persona: "user.preset-7", prompt: "派给自己" },
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(res.body.error, /already running under/);
});
