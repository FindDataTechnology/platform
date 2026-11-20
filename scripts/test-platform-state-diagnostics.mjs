#!/usr/bin/env node
// ── 平台状态诊断入口的验收（retire-orphan-platform-state 3.1–3.3）───────────
//
//   node --test scripts/test-platform-state-diagnostics.mjs
//
// 钉四个契约面：
//   ① 3.2 双向：同一个 fixture 根里，被本测试进程持有连接的库判 live、
//      无人持有的判 orphan（结论相反），且 orphan 带最后写入时间；
//   ② 3.3 零回显：token 字面量绝不出现在输出里；
//   ③ 覆盖不全必须说明：坏库（非 sqlite 的 garbage）与缺表都出现在输出里
//      并带原因，绝不静默省略；
//   ④ 退出码语义：有降级 → 2；全部可读 → 0；无可读来源 → 1。
//
// 持有判定走 lsof（macOS 开发机）或 /proc（pod）；两边都能看到本测试进程
// 对 fixture A 的真实打开连接——不是 stub。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import Database from "better-sqlite3";

const here = path.dirname(fileURLToPath(import.meta.url));

function makeCellDb(cellRoot) {
  const dbDir = path.join(cellRoot, "data", "data");
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, "app.db");
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE user_registry_credentials (
    email TEXT PRIMARY KEY, token TEXT, expires_at TEXT, stale INTEGER, source TEXT, updated_at TEXT)`);
  db.prepare("INSERT INTO user_registry_credentials VALUES (?,?,?,?,?,?)").run(
    "aloadtree@gmail.com", "sk-SECRETTOKENVALUE-XYZ", "2099-01-01T00:00:00Z", 0, "sso", "2026-11-17T00:00:00Z");
  db.prepare("INSERT INTO user_registry_credentials VALUES (?,?,?,?,?,?)").run(
    "stale-owner@example.com", "sk-OLD-2", "2020-01-01T00:00:00Z", 0, "sso", "2020-01-01T00:00:00Z");
  return { db, dbPath };
}

test("诊断入口：活体/孤儿结论相反、零凭据回显、坏库降级、退出码语义", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "diag-cells-"));
  // cell-held：本测试进程持有连接（故意不引用——它要活到测试结束；`_` 前缀让
  // biome 的 noUnusedVariables 知道这是有意的，而不是漏改的残留）
  const _held = makeCellDb(path.join(root, "cellheld"));
  // cell-orphan：建好就关
  const orphan = makeCellDb(path.join(root, "cellorphan"));
  orphan.db.close();
  // cell-garbage：app.db 是非 sqlite 文件
  const gRoot = path.join(root, "cellgarbage", "data", "data");
  fs.mkdirSync(gRoot, { recursive: true });
  fs.writeFileSync(path.join(gRoot, "app.db"), "this is not sqlite");
  // cell-empty：目录存在但无任何状态文件
  fs.mkdirSync(path.join(root, "cellempty", "data"), { recursive: true });

  let r = "", exitCode = 0;
  try {
    r = execFileSync(process.execPath,
      [path.join(here, "diagnose-platform-state.mjs"), "--cells-root", root],
      { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    // 有降级项时脚本 exit 2——JSON 已在 stdout，抓回来继续断言
    r = e.stdout ?? "";
    exitCode = e.status;
  }
  assert.equal(exitCode, 2, "坏库 + 平台库缺失 ⇒ 必有降级项，exit 2");
  const lines = r.split("\n");
  const startIdx = lines.findIndex((l) => l.startsWith("{"));
  assert.ok(startIdx >= 0, "输出必须是 JSON");
  const out = JSON.parse(lines.slice(startIdx).join("\n"));

  const heldItem = out.sources.find((s) => s.kind === "cell:cellheld");
  const orphanItem = out.sources.find((s) => s.kind === "cell:cellorphan");
  const garbageItem = out.sources.find((s) => s.kind === "cell:cellgarbage");
  assert.ok(heldItem && orphanItem && garbageItem, "三个 cell 都必须出现在输出里（覆盖不省略）");

  // ① 活体/孤儿结论相反（3.2）
  assert.equal(orphanItem.status, "orphan", "无持有者 ⇒ orphan");
  assert.ok(orphanItem.lastWriteAt, "orphan 必须带最后写入时间");
  if (heldItem.holder.status === "unknown") {
    // 持有仪器不可用的环境（无 lsof）——只断言它没被误判成 orphan
    assert.notEqual(heldItem.status, "orphan", "有真实持有者的库不得判 orphan");
    assert.equal(heldItem.degraded, true);
  } else {
    assert.equal(heldItem.status, "live", "被本进程持有的库 ⇒ live");
    assert.ok(heldItem.holder.holders.length >= 1, "至少报告一个持有者（本测试进程自己的连接）");
  }

  // ② 零凭据回显（3.3）
  assert.ok(!r.includes("sk-SECRETTOKENVALUE-XYZ"), "token 字面量绝不出现在输出");
  assert.ok(!r.includes("sk-OLD-2"), "过期 token 同样不回显");
  const credRows = heldItem.credentials?.rows ?? [];
  assert.equal(credRows.length, 2, "凭据行按 cell 汇总");
  const fresh = credRows.find((c) => c.email === "aloadtree@gmail.com");
  const stale = credRows.find((c) => c.email === "stale-owner@example.com");
  assert.equal(fresh.expired, false, "未来到期 ⇒ 未过期");
  assert.equal(stale.expired, true, "2020 到期 ⇒ 已过期");

  // ③ 坏库降级并说明（覆盖不省略）
  assert.equal(garbageItem.credentials.status, "degraded", "非 sqlite 文件必须标 degraded");
  assert.ok(garbageItem.credentials.reason.length > 0);

  // 空目录 cell 进 skipped（可见，不是静默）
  assert.ok(out.skipped.some((s) => s.cell === "cellempty"), "无状态文件的 cell 显式 skip 并说明");
});

test("退出码：无任何可读来源 ⇒ 1（不臆断「未发现问题」）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "diag-empty-"));
  fs.mkdirSync(path.join(root, "lone", "data"), { recursive: true }); // 无状态文件的 cell
  let code = 0, stderr = "";
  try {
    execFileSync(process.execPath, [path.join(here, "diagnose-platform-state.mjs"), "--cells-root", root, "--no-platform"],
      { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    code = e.status;
    stderr = e.stderr?.toString() ?? "";
  }
  assert.equal(code, 1, `无来源必须 exit 1，实得 ${code}`);
  assert.match(stderr, /没有任何可读来源/);
  assert.ok(!stderr.includes("未发现问题"));
});
