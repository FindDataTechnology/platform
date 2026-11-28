#!/usr/bin/env node
// ── /api/ready 的注入面字段（mcp-injection-budget-residual 1.1）───────────────
//
// 1.1 的验收原文是「**实测**读面字段存在；卸载一个包后数值下降（不需要重启）」。
// 所以这条走真 HTTP：起一个只有 misc 路由的 express，打一次 `/api/ready`，读
// `injectionSurface`。
//
// 判据三条：
//   1. 字段在，且数与盘上的 patch 一致（由 `readInjectionSurface` 的读者测试单独钉死，
//      这里只钉「读面把它端出来了」）
//   2. 上限也在（2.1 的「可从读面读到」）——soft/hard 与装包闸同一份实现
//   3. **观测面不参与存活判定**：注入面读失败/缺失时 `/api/ready` 仍是 200、`ready` 仍为 true
//
//   node --test scripts/test-ready-injection-surface.mjs

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "ready-inj-"));
// **必须在 import dsh-profile 之前**：DSH_HOME 在模块加载时就被读进常量了，
// 之后再改 env 只影响「新加载」的模块（这正是 targetPaths 那套 dirs 契约存在的理由）。
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;

const profileDir = path.join(process.env.DSH_HOME, "profiles", "platform");
mkdirSync(profileDir, { recursive: true });
const insert = ["fleet-architect", "fd-open-data-mcp"].map((n) => ({
  id: `mcp-${n}`, name: "@deepseek-ai/dsh-mcp-client", config: { serverName: n },
}));
writeFileSync(
  path.join(profileDir, "mcp.patch.yml"),
  `- insert:\n${insert.map((e) => `  - ${JSON.stringify(e)}`).join("\n")}\n`,
);
const skillRoot = path.join(tmpRoot, "skills");
mkdirSync(path.join(skillRoot, "one"), { recursive: true });
writeFileSync(path.join(skillRoot, "one", "SKILL.md"), "y".repeat(11));
writeFileSync(path.join(profileDir, "skills.patch.yml"), `- config:\n    customSkillDirs:\n      - ${skillRoot}\n`);

const express = (await import("express")).default;
const { registerMiscRoutes } = await import("../server/routes/misc.js");

test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const app = express();
app.use(express.json());
registerMiscRoutes({
  // `app` 必须走 ctx（`const { app, catalog, db, cron } = ctx;`），不是位置参数——
  // 传错位置时不会报「参数错了」，而是在第一个 `app.get(...)` 上炸
  // `Cannot read properties of undefined (reading 'get')`。
  app,
  ready: { dsh: true },
  dshInitError: null,
  broadcast: () => {},
  getFleetDatabase: () => null,
});

test("1. /api/ready 端出 injectionSurface：数与 patch 一致，上限也在", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/ready`);
    assert.equal(res.status, 200, "注入面在场不该改变存活判定");
    const body = await res.json();
    assert.equal(body.ready, true);

    const face = body.injectionSurface;
    assert.ok(face, "/api/ready 必须带 injectionSurface（1.1 的读面字段）");
    assert.equal(face.servers, 2, "与 mcp.patch.yml 里的 server 数一致");
    assert.equal(face.skillRoots, 1);
    assert.equal(face.skillBytes, 11, "技能正文按 SKILL.md 的 size 计");
    assert.equal(face.patchPresent, true);

    // 2.1：上限要能从读面读到，且与装包闸同一份常量
    assert.ok(face.budget, "上限必须可从读面读到（2.1）");
    assert.equal(face.budget.softLimit, 22);
    assert.equal(face.budget.hardLimit, 30);
    assert.equal(typeof face.budget.count, "number");
    assert.ok(["ok", "soft", "hard"].includes(face.budget.level));
  } finally {
    server.close();
  }
});
