// 房间记忆面板测试（add-memory-visible-ux 任务 4）：两层。
//   1) entries 代理 project 透传（server/routes/memory.js）：非空字符串才透传、
//      缺省不带该键（字节等同回滚）、身份缝仍是 owner person 令牌（代理即
//      权限边界，D4）。范式=项目既有 mock http 替身（memory-recall/observe-tap
//      同思路），express 路由以最小 app 实例直挂真端口。
//   2) 隐私红线静态断言：web 无组件测试设施（无 vitest/testing-library），
//      「成员/访客零渲染」以源码级断言钉死——ZhiyuRoomPage 的房间记忆区块
//      必须整体包在 {isOwner && (...)} 门卫内，且拉取 effect 以 isOwner 前置。

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { registerMemoryRoutes } from "../server/routes/memory.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── mock fd-memory：/admin/mint + /memory（visibility 读面替身，记 query）──
function mockMemory() {
  const memoryHits = [];
  const mintBodies = [];
  const server = createServer((req, res) => {
    const u = String(req.url);
    if (u.startsWith("/memory")) {
      memoryHits.push(u);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([
        {
          path: "room-abc/turn-1",
          title: "部署脚本要加 --frozen-lockfile",
          project: "room-abc",
          layer: "L0",
          ts: "2026-11-07T10:00:00Z",
          metadata: { lane: "zhiyu" },
        },
      ]));
      return;
    }
    if (u.startsWith("/admin/mint")) {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        mintBodies.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: "person-tok" }));
      });
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  return { server, memoryHits, mintBodies };
}

// ── 最小 express 实例：桩 auth 中间件（头→req.user）+ 被测路由 ────────────
function buildApp() {
  const app = express();
  app.use((req, _res, next) => {
    const email = req.headers["x-test-user"];
    if (typeof email === "string" && email) req.user = { email };
    next();
  });
  registerMemoryRoutes({ app });
  return app;
}

const ENV_KEYS = ["CELL_MEMORY_ENABLED", "CELL_MEMORY_URL", "CELL_MEMORY_PLATFORM_TOKEN", "CELL_MEMORY_DATA"];
const ENV_SNAPSHOT = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const dirs = [];
afterEach(() => {
  // env 快照还原：server/routes/memory.js 请求时读 process.env，逐测独立。
  for (const [k, v] of Object.entries(ENV_SNAPSHOT)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

// 起全套：mock fd-memory + 被测 express app（真端口）。每测独立 CELL_MEMORY_DATA
// （SDK personTokenFor 有磁盘缓存，共享目录会串测试——observe-tap.test.mjs 同戒）。
async function withHarness(run, { envOverrides = {} } = {}) {
  const mem = mockMemory();
  await new Promise((r) => mem.server.listen(0, "127.0.0.1", r));
  const data = mkdtempSync(join(tmpdir(), "mem-room-panel-"));
  dirs.push(data);
  Object.assign(process.env, {
    CELL_MEMORY_ENABLED: "1",
    CELL_MEMORY_URL: `http://127.0.0.1:${mem.server.address().port}`,
    CELL_MEMORY_PLATFORM_TOKEN: "plat",
    CELL_MEMORY_DATA: data,
    ...envOverrides,
  });
  const server = buildApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, memoryHits: mem.memoryHits, mintBodies: mem.mintBodies });
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => mem.server.close(r));
  }
}

async function getEntries(base, qs, email = "owner@x") {
  const r = await fetch(`${base}/api/memory/entries${qs}`, {
    headers: email ? { "x-test-user": email } : {},
  });
  return { status: r.status, doc: await r.json().catch(() => null) };
}

// ── 1) project 透传 ────────────────────────────────────────────────────────

test("project 非空字符串透传：?project=room-abc → 上游 /memory 带 project 键", async () => {
  await withHarness(async ({ base, memoryHits, mintBodies }) => {
    const { status, doc } = await getEntries(base, "?project=room-abc");
    assert.equal(status, 200);
    assert.ok(Array.isArray(doc.items), "fd-memory 返回以 {items:[...]} 原样透出");
    assert.equal(doc.items[0].title, "部署脚本要加 --frozen-lockfile");
    assert.equal(memoryHits.length, 1);
    assert.ok(
      memoryHits[0].startsWith("/memory?project=room-abc&"),
      `上游首参即 project，实际 ${memoryHits[0]}`,
    );
    assert.ok(memoryHits[0].includes("limit=50"), "其余参数面零改动（limit 默认仍在）");
    // 代理即权限边界：owner person 令牌（namespace u/<email>），只读本人根。
    assert.equal(mintBodies.length, 1);
    assert.equal(JSON.parse(mintBodies[0]).namespace, "u/owner@x");
  });
});

test("project 与既有参数共存：layer/limit 原样、project 追加", async () => {
  await withHarness(async ({ base, memoryHits }) => {
    const { status } = await getEntries(base, "?layer=L0&project=room-abc&limit=5");
    assert.equal(status, 200);
    assert.equal(memoryHits[0], "/memory?layer=L0&project=room-abc&limit=5&offset=0");
  });
});

test("缺省不带 project：上游 query 与改动前逐字节一致（回滚零差）", async () => {
  await withHarness(async ({ base, memoryHits }) => {
    const { status } = await getEntries(base, "");
    assert.equal(status, 200);
    assert.equal(memoryHits[0], "/memory?limit=50&offset=0");
  });
});

test("非空字符串校验：空白串与数组值都不透传", async () => {
  await withHarness(async ({ base, memoryHits }) => {
    const blank = await getEntries(base, `?project=${encodeURIComponent("   ")}`);
    assert.equal(blank.status, 200);
    assert.ok(!memoryHits.at(-1).includes("project"), "纯空白 project 不透传");

    const arr = await getEntries(base, "?project=a&project=b");
    assert.equal(arr.status, 200);
    assert.ok(!memoryHits.at(-1).includes("project"), "数组值（重复键）不透传");
  });
});

// ── 2) 身份/降级缝不回归 ──────────────────────────────────────────────────

test("未登录 401：project 不改身份缝", async () => {
  await withHarness(async ({ base }) => {
    const { status, doc } = await getEntries(base, "?project=room-abc", "");
    assert.equal(status, 401);
    assert.equal(doc.code, "unauthenticated");
  });
});

test("记忆未配置 503：CELL_MEMORY_ENABLED 缺失仍降级开门", async () => {
  await withHarness(async ({ base }) => {
    delete process.env.CELL_MEMORY_ENABLED;
    const { status, doc } = await getEntries(base, "?project=room-abc");
    assert.equal(status, 503);
    assert.equal(doc.code, "memory_unavailable");
  });
});

// ── 3) 隐私红线：房主独占（源码级静态断言——web 无组件测试设施） ──────────

test("ZhiyuRoomPage：房间记忆区块整体包在 {isOwner && (...)} 内（成员/访客零渲染）", () => {
  const src = readFileSync(join(ROOT, "web/src/pages/ZhiyuRoomPage.tsx"), "utf8");
  const idx = src.indexOf('data-testid="zy-room-memory"');
  assert.ok(idx !== -1, "房间记忆折叠区存在");
  assert.equal(
    [...src.matchAll(/data-testid="zy-room-memory"/g)].length, 1,
    "区块根 testid 唯一（toggle/body/entry 用派生名）",
  );
  const guard = src.lastIndexOf("{isOwner && (", idx);
  assert.ok(guard !== -1, "区块被 isOwner 门卫包裹");
  const between = src.slice(guard, idx);
  assert.ok(
    !between.includes(")}"),
    "门卫与区块之间无闭合——区块确实整体在该门卫作用域内（不渲染，非置灰）",
  );
  assert.ok(
    src.includes("if (!isOwner || !memOpen) return;"),
    "拉取 effect 以 isOwner 前置：非房主不发 project 请求",
  );
  assert.ok(
    /\/api\/memory\/entries\?project=\$\{encodeURIComponent\(`room-\$\{roomId\}`\)\}/.test(src),
    "拉取走既有 entries 代理的 room-<roomId> project 参数化",
  );
});
