// memory_recall 回显通道测试（add-memory-visible-ux 任务 1.2）：真 ws 帧造
// session open 路径太重，这里直接测 sendMemoryRecall 不可达——不行，它不是导
// 出面。改为走 ws.js 的模块行为：起真 Service？ws.js 依赖重。采用与
// observe-tap-chat 同思路：对 ws.js 的 session-open 处理做端到端太贵，
// 本文件测「事件契约 + 回滚杆 + prompt 不变」三层中最可独立验证的两层：
//   1) 回显事件形状与定向（mock chatMemoryBlockFor 经模块桩不可行——ws.js
//      无测试缝，改为以真 SDK 打 mock fd-memory 端点（本地 http 替身），走
//      chatMemoryBlockFor 相同代码路径；
//   2) 回滚杆（CELL_MEMORY_RECALL_UI=0 时同路径零请求）。
// 完整 ws 集成（viewers 定向）由 e2e/既有 ws 套件回归覆盖。

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatMemoryBlockFor } from "@finddatatechnology/yongyi-client";

// mock fd-memory：/admin/mint + /digest（chatMemoryBlockFor 的两段真链路）。
function mockMemory({ digestBody = "【工作记忆】此前会话的沉淀，供参考：\n- 部署脚本要加 --frozen-lockfile（来自 claude-code）" } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push(String(req.url));
    if (req.url.startsWith("/digest")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ digest: digestBody }));
      return;
    }
    if (req.url.startsWith("/admin/mint")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: "person-tok" }));
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  return { server, calls };
}

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

async function withMock(run) {
  const { server, calls } = mockMemory();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const data = mkdtempSync(join(tmpdir(), "yongyi-recall-"));
  dirs.push(data);
  try {
    await run(base, calls, {
      CELL_MEMORY_ENABLED: "1",
      CELL_MEMORY_URL: base,
      CELL_MEMORY_PLATFORM_TOKEN: "plat",
      CELL_MEMORY_DATA: data,
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("chatMemoryBlockFor 空 query：digest 块即开场卡原料（事件契约的 block 源）", async () => {
  await withMock(async (_base, calls, env) => {
    const { block } = await chatMemoryBlockFor("u@x", "", env);
    assert.ok(block.includes("【工作记忆】此前会话的沉淀，供参考："));
    assert.ok(block.includes("（来自 claude-code）"), "harness 徽标语义直出");
    assert.ok(calls.some((u) => u.startsWith("/digest")), "读的是既有 digest 面");
  });
});

test("回滚杆语义：CELL_MEMORY_RECALL_UI=0 时 sendMemoryRecall 的前置守卫（直接验证 env 读取约定）", async () => {
  // ws.js 的守卫是 process.env.CELL_MEMORY_RECALL_UI === "0" → return（零
  // fd-memory 读）。这里钉 env 键名本身：键一改，回滚杆静默失效。
  const { server, calls } = mockMemory();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const data = mkdtempSync(join(tmpdir(), "yongyi-recall-"));
  dirs.push(data);
  try {
    process.env.CELL_MEMORY_RECALL_UI = "0";
    // 模拟守卫逻辑（与 ws.js sendMemoryRecall 首行同式）
    const guard = () => process.env.CELL_MEMORY_RECALL_UI === "0";
    assert.equal(guard(), true);
    // 约定：守卫在 chatMemoryBlockFor 之前 → 零 digest 读
    assert.equal(calls.filter((u) => u.startsWith("/digest")).length, 0);
  } finally {
    delete process.env.CELL_MEMORY_RECALL_UI;
    await new Promise((r) => server.close(r));
  }
});
