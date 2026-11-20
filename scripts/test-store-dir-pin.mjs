#!/usr/bin/env node
// ── storeDir 的无 env 退回：钉到仓根，不再静默落到 cwd ──────────────────────
//
// retire-orphan-platform-state 2.1。
//
// 为什么要这条：`storeDir(subdir)` 在 PLATFORM_DATA_DIR 与模块 override 都缺席时，
// 旧实现 `path.resolve(subdir)` 按**进程 cwd** 解析 —— 任何从别的目录起的进程
// （一次性探针、诊断脚本、跑错目录的运维命令）都会在自己的 cwd 下静默拿到/建出
// 另一份 `<cwd>/data/app.db`，然后把它当成平台库去下结论。E13（hotel-debt-ledger）
// 的错结论正是这一族：「诊断读了一份长得像平台唯一的库」。
//
// 修复后无 env 退回钉在 repoRoot（由本模块位置解析，不随 cwd 走），并向 stderr
// 打一行可见警告 —— 「不静默」与「不落 cwd」是同一件事的两半，这条用例两半都钉。
// 另两半钉契约不被误伤：模块 override 依旧最高优先、PLATFORM_DATA_DIR 在场时
// 行为逐字节不变（cell 由 spawner 显式带上它，见 gateway/spawner.js）。
//
//   node --test scripts/test-store-dir-pin.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const pathsJs = path.join(repoRoot, "paths.js");
const pathsHref = JSON.stringify(pathToFileURL(pathsJs).href);

// Child runs with BOTH env vars absent and cwd = a throwaway dir. It resolves
// TWO stores (data + cron) so the warn-once contract has two chances to fire.
function runChild(extraEnv = {}, body) {
  const childCwd = fs.mkdtempSync(path.join(os.tmpdir(), "store-pin-"));
  const env = { ...process.env };
  delete env.PLATFORM_DATA_DIR;
  delete env.DB_PATH;
  Object.assign(env, extraEnv);
  const code = body ?? `
    const fs = await import("node:fs");
    const { storeDir } = await import(${pathsHref});
    const data = storeDir("data");
    const cron = storeDir("cron");
    console.log(JSON.stringify({ data, cron, cwd: process.cwd(), cwdDataExisted: fs.existsSync("data") }));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code, ""],
    { cwd: childCwd, env: { ...env, NODE_OPTIONS: "" }, encoding: "utf8" });
  return { childCwd, cwdData: path.join(childCwd, "data"), stdout: r.stdout, stderr: r.stderr, status: r.status };
}

const parse = (t) => {
  const line = (t.stdout || "").split("\n").find((l) => l.startsWith("{"));
  assert.ok(line, `child must print one JSON line, got stdout=${t.stdout} stderr=${t.stderr}`);
  return JSON.parse(line);
};

test("A: 无 env 时钉到仓根，且不是 cwd 相对", () => {
  const t = runChild();
  assert.equal(t.status, 0, `child exited ${t.status}: ${t.stderr}`);
  const j = parse(t);
  assert.equal(j.data, path.join(repoRoot, "data"), "fallback must pin to repoRoot('data')");
  assert.equal(j.cron, path.join(repoRoot, "cron"), "every subdir gets the same treatment");
  assert.notEqual(j.data, path.join(j.cwd, "data"), "must NOT resolve cwd-relative");
});

test("B: 进程没拿到任何 env，也不会在 cwd 下静默建出 data/", () => {
  // B 必须真「开库」：只断言解析路径测不到变更的缝（解析从不建文件，突变下照样绿）。
  // 子进程在解析到的位置真写一份 app.db，断言 <cwd>/data/app.db 不存在，再清掉自己
  // 建的东西（unlink + 空目录 rmdir；目录若已有内容则留着不动）。
  const t = runChild({}, `
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { storeDir } = await import(${pathsHref});
    const data = storeDir("data");
    const dbFile = path.join(data, "app.db");
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(dbFile, "");
    console.log(JSON.stringify({ data, cwd: process.cwd(), cwdDbExisted: fs.existsSync(path.join(process.cwd(), "data", "app.db")) }));
    fs.unlinkSync(dbFile);
    try { fs.rmdirSync(data); } catch { /* not empty — leave it */ }
  `);
  assert.equal(t.status, 0, `child exited ${t.status}: ${t.stderr}`);
  const j = parse(t);
  assert.equal(j.cwdDbExisted, false, "opening the DB must not land at <cwd>/data/app.db");
  assert.equal(fs.existsSync(t.cwdData), false, "<cwd>/data must not come into being");
});

test("C: 「不静默」——stderr 有一行点名缺哪个 env、落到哪，且两次调用只警告一次", () => {
  const t = runChild();
  assert.match(t.stderr, /\[paths\] PLATFORM_DATA_DIR/, "warning must name the missing env");
  assert.match(t.stderr, /repo root, not cwd/, "warning must say the fallback is repo-root pinned");
  const warnLines = t.stderr.split("\n").filter((l) => l.includes("[paths]"));
  assert.equal(warnLines.length, 1, "warn once per process, not per storeDir call");
});

test("D: 模块 override 依旧最高优先（不误伤显式定位）", () => {
  const childCwd = fs.mkdtempSync(path.join(os.tmpdir(), "store-pin-ovr-"));
  const env = { ...process.env };
  delete env.PLATFORM_DATA_DIR;
  delete env.DB_PATH;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { storeDir } = await import(${pathsHref});
    console.log(JSON.stringify({ a: storeDir("data", "/tmp/ovr-explicit"), b: storeDir("sessions", "rel-ovr") }));
  `, ""], { cwd: childCwd, env: { ...env, NODE_OPTIONS: "" }, encoding: "utf8" });
  const line = (r.stdout || "").split("\n").find((l) => l.startsWith("{"));
  const j = JSON.parse(line);
  assert.equal(j.a, "/tmp/ovr-explicit", "absolute override must win verbatim");
  // macOS: /var is a symlink to /private/var, so the child's path.resolve
  // yields the realpath while mkdtemp handed us the /var spelling.
  assert.equal(j.b, path.join(fs.realpathSync(childCwd), "rel-ovr"), "relative override still resolves against cwd (override semantics unchanged)");
  assert.ok(!r.stderr.includes("[paths]"), "an override in play must not warn about missing env");
});

test("E: PLATFORM_DATA_DIR 在场时行为逐字节不变", () => {
  const pdd = fs.mkdtempSync(path.join(os.tmpdir(), "store-pin-pdd-"));
  const t = runChild({ PLATFORM_DATA_DIR: pdd });
  assert.equal(t.status, 0, `child exited ${t.status}: ${t.stderr}`);
  const j = parse(t);
  assert.equal(j.data, path.join(pdd, "data"), "PLATFORM_DATA_DIR branch unchanged");
  assert.equal(j.cron, path.join(pdd, "cron"), "PLATFORM_DATA_DIR branch unchanged (cron)");
  assert.ok(!t.stderr.includes("[paths]"), "pinned process must not warn");
});
