// ── 根路径归 shell，八个视图都可达（merge-plaza-into-facet-entry 1.x）─────────
//
//   node --test scripts/test-facet-root-ownership.mjs
//
// 钉住这场回归的直接原因与修法：
//
// 2026-11-21 之前，`seedFrontHall` 把素材广场的静态页铺成 SITE_ROOT/index.html，
// 而 facet 又把 SITE_ROOT 的静态挂载排在 WEB_DIST 之前、带 `index:"index.html"`。
// 于是 `GET /` 被广场页吃掉，谦面 SPA 的 hash 视图（我的发布 / 运营板 / 创作台）
// 全部不可达——**产品失去操作界面**，而没有任何闸看见它。
//
// 修法两条，本测试各钉一条：
//   ① seedFrontHall 不铺 index.html，且删掉残留；
//   ② SITE_ROOT 的静态挂载 `index: false`。
// 再加一条端到端：八个 hash 视图的**文档地址**（浏览器只把 hash 之前的部分发给
// 服务器）都必须是同一份 shell 文档——hash 本身服务端看不见，所以判据是
// 「所有视图共享同一个文档，且那个文档是 shell 而不是广场页」。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { seedFrontHall } from "../facet/plaza-export-schedule.js";

const SHELL = "<!doctype html><html><head><title>谦面 Facet — 智能体市场</title></head><body>shell</body></html>";
const PLAZA = "<!doctype html><html><head><title>壹座·智能体素材广场</title></head><body>plaza</body></html>";

function makeSiteRoot({ staleIndex = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "root-own-"));
  fs.writeFileSync(path.join(dir, "style.css"), "body{}");
  fs.mkdirSync(path.join(dir, "generated"));
  fs.writeFileSync(path.join(dir, "generated", "catalog.json"), '{"materials":[]}');
  if (staleIndex) fs.writeFileSync(path.join(dir, "index.html"), PLAZA);
  return dir;
}

function makeShell() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-"));
  fs.writeFileSync(path.join(dir, "index.html"), SHELL);
  return dir;
}

/** The exact mount order facet/index.js uses for these two handlers. */
async function startApp({ siteRoot, shellDir }) {
  const app = express();
  app.use(express.static(siteRoot, { index: false }));
  app.use(express.static(shellDir, { index: "index.html" }));
  app.get(/^\/(?!api\/|auth\/).*/, (_req, res) => res.sendFile(path.join(shellDir, "index.html")));
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

test("seedFrontHall never seeds index.html, and removes a stale one", () => {
  // 用一个最小的 front-hall 源目录（含 index.html）——它**不该**被搬。
  const from = fs.mkdtempSync(path.join(os.tmpdir(), "hall-src-"));
  fs.writeFileSync(path.join(from, "index.html"), PLAZA);
  fs.writeFileSync(path.join(from, "style.css"), "body{}");

  const siteRoot = makeSiteRoot({ staleIndex: true });
  assert.equal(fs.existsSync(path.join(siteRoot, "index.html")), true, "precondition: stale index present");

  const copied = seedFrontHall({ siteRoot, from });
  assert.ok(copied.includes("style.css"), "other assets still seed");
  assert.equal(copied.includes("index.html"), false, "index.html must not be seeded");
  assert.equal(fs.existsSync(path.join(siteRoot, "index.html")), false, "stale index.html must be removed");
});

test("the root path serves the shell, not a site-root index", async () => {
  const siteRoot = makeSiteRoot({ staleIndex: true });
  const shellDir = makeShell();
  // 清掉残留（模拟 seedFrontHall 跑过之后的状态）
  seedFrontHall({ siteRoot, from: fs.mkdtempSync(path.join(os.tmpdir(), "empty-")) });

  const app = await startApp({ siteRoot, shellDir });
  try {
    const res = await fetch(`${app.base}/`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /谦面 Facet/, "root must render the shell");
    assert.equal(body.includes("壹座·智能体素材广场"), false, "root must never be the plaza static page");
  } finally {
    await app.close();
  }
});

test("even with a stray site-root index.html, index:false keeps the root on the shell", async () => {
  // 第二条保险：不清残留、只靠 `index: false`，根路径仍归 shell。
  const siteRoot = makeSiteRoot({ staleIndex: true });
  const shellDir = makeShell();
  const app = await startApp({ siteRoot, shellDir });
  try {
    const body = await (await fetch(`${app.base}/`)).text();
    assert.match(body, /谦面 Facet/, "index:false alone must prevent the stale index from owning /");
  } finally {
    await app.close();
  }
});

test("every hash view's document address serves the same shell document", async () => {
  // 浏览器只把 hash 之前的部分发给服务器，所以八个视图共享一个文档地址 `/`。
  // 判据：它们全都拿到同一份 shell 字节——不是广场页，也不是 404。
  const siteRoot = makeSiteRoot();
  const shellDir = makeShell();
  const app = await startApp({ siteRoot, shellDir });
  try {
    const views = ["", "#/packs", "#/mcp", "#/docs", "#/mine", "#/curate", "#/studio", "#/fleets"];
    const bodies = new Set();
    for (const v of views) {
      const res = await fetch(`${app.base}/${v}`);
      assert.equal(res.status, 200, `/${v} must serve a document`);
      bodies.add(await res.text());
    }
    assert.equal(bodies.size, 1, "all views must share one document");
    assert.match([...bodies][0], /谦面 Facet/, "and that document is the shell");
  } finally {
    await app.close();
  }
});

test("machine surfaces under the site root are still served", async () => {
  const siteRoot = makeSiteRoot();
  const shellDir = makeShell();
  const app = await startApp({ siteRoot, shellDir });
  try {
    const res = await fetch(`${app.base}/generated/catalog.json`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /materials/);
  } finally {
    await app.close();
  }
});
