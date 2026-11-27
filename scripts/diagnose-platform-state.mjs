#!/usr/bin/env node
// ── 平台状态只读诊断：先判活，再下结论 ─────────────────────────────────────
//
// retire-orphan-platform-state 3.1–3.3（capability: platform-state-diagnostics）。
//
// 为什么要这个入口：平台里存在多份字面相同的 `data/data/app.db`（pod 级与每个
// cell 一份），hotel 线 E13 的错结论就来自「诊断读了一份长得像平台唯一的库」。
// 本入口把三件事一次说清，并按「平台库诊断纪律」执行：
//   ① 每个来源标 provenance + 是否被进程持有（inode 判定，不信路径字符串——
//      `/proc/<pid>/root` 是假阳性仪器，见 tasks.md 1.4）；
//   ② 凭据/队列按 cell 汇总，覆盖所有持有自身状态库的 cell；不可读的 cell
//      标 degraded 并给原因，绝不静默省略；
//   ③ 凭据零回显（只出 email/expires_at/stale/是否过期，token 永不出现在输出）。
//
// 退出码：0 = 全部来源读到且无降级；1 = 一个可读来源都没有；2 = 部分降级
// （哪个来源哪一项降级、为什么，逐条在输出里）。
//
//   node scripts/diagnose-platform-state.mjs [--cells-root /data/cells]

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { storeDir } from "../paths.js";
import Database from "better-sqlite3";

const now = () => new Date().toISOString();
const isExpired = (iso) => {
  if (!iso) return null; // 无到期时间 ≠ 过期，如实返 null
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t < Date.now();
};

// ── 持有判定：对 fd 本身取 inode，绝不按路径字符串匹配 ─────────────────────
function holdersByProc(dbPath) {
  const st = fs.statSync(dbPath);
  const holders = [];
  for (const pidDir of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(pidDir)) continue;
    const fdDir = path.join("/proc", pidDir, "fd");
    let fds;
    try { fds = fs.readdirSync(fdDir); } catch { continue; }
    for (const fd of fds) {
      let fst;
      try { fst = fs.statSync(path.join(fdDir, fd)); } catch { continue; }
      if (fst.ino !== st.ino || fst.dev !== st.dev) continue;
      let opened = null;
      try { opened = fs.readlinkSync(path.join(fdDir, fd)); } catch { /* gone */ }
      let cmd = "";
      try { cmd = fs.readFileSync(path.join("/proc", pidDir, "cmdline"), "utf8").replace(/\0/g, " ").trim(); } catch { /* gone */ }
      holders.push({ pid: Number(pidDir), cmd, openedPath: opened });
    }
  }
  return holders;
}

function holdersByLsof(dbPath) {
  let out = "";
  try {
    out = execFileSync("lsof", ["-t", "--", dbPath], { encoding: "utf8", timeout: 15000 });
  } catch (e) {
    // lsof 对「无人持有」退出码是 1 且无输出——那是判定结果，不是仪器故障
    if (e.status === 1 && !(e.stdout ?? "").trim()) return [];
    throw e;
  }
  const pids = out.split(/\s+/).filter(Boolean).map(Number);
  return pids.map((pid) => {
    let cmd = "";
    try { cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim(); } catch { /* gone */ }
    return { pid, cmd, openedPath: dbPath };
  });
}

function holderReport(dbPath) {
  const st = fs.statSync(dbPath);
  let holders, instrument;
  if (fs.existsSync("/proc")) {
    instrument = "/proc/*/fd stat -L（inode 判定）";
    holders = holdersByProc(dbPath);
  } else {
    try {
      instrument = "lsof -t";
      holders = holdersByLsof(dbPath);
    } catch (e) {
      return { instrument: "lsof -t", status: "unknown", reason: `lsof 不可用：${e.message.split("\n")[0]}`, holders: null };
    }
  }
  // 同 inode 的打开数可能多于目录条目（重复 fd），按 pid 去重
  const byPid = new Map(holders.map((h) => [h.pid, h]));
  const verdict = byPid.size > 0 ? "live" : "orphan";
  return { instrument, status: verdict, holders: [...byPid.values()], ino: st.ino };
}

// ── 单个状态库的读面 ────────────────────────────────────────────────────────
function readSqliteSide(dbPath, db) {
  const item = {};
  let tables;
  try {
    tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  } catch (e) {
    const reason = `sqlite_master 读不了：${e.message.split("\n")[0]}`;
    return { degraded: true, reason, credentials: { status: "degraded", reason } };
  }
  if (tables.includes("user_registry_credentials")) {
    try {
      const rows = db.prepare(
        "SELECT email, expires_at AS expiresAt, stale, source, updated_at AS updatedAt FROM user_registry_credentials"
      ).all();
      // 零回显：token 永不进 SELECT，更不进输出
      item.credentials = {
        source: `${dbPath} :: user_registry_credentials`,
        rows: rows.map((r) => ({ email: r.email, expiresAt: r.expiresAt, stale: !!r.stale, expired: isExpired(r.expiresAt), updatedAt: r.updatedAt })),
      };
    } catch (e) {
      item.credentials = { status: "degraded", reason: `凭据表读不了：${e.message.split("\n")[0]}` };
    }
  } else {
    item.credentials = { status: "absent", note: "库内无 user_registry_credentials 表" };
  }
  const budgetTables = tables.filter((t) => /budget/i.test(t));
  item.budget = budgetTables.length
    ? { status: "unbound", note: "库内有预算形表但口径未绑定，仅报名字不臆断", tables: budgetTables }
    : { status: "absent", note: "库内无预算形表（预算口径不在状态库）" };
  return item;
}

function diagnoseDb(kind, dbPath, jobsPath) {
  const item = { kind, source: dbPath };
  if (!fs.existsSync(dbPath)) {
    item.status = "missing";
    item.note = "文件不存在（不是孤儿：孤儿=存在但无人持有）";
    return item;
  }
  const st = fs.statSync(dbPath);
  item.sizeBytes = st.size;
  item.lastWriteAt = st.mtime.toISOString();
  // 持有判定
  try {
    const h = holderReport(dbPath);
    item.holder = h;
    item.status = h.status; // live | orphan | unknown
    if (h.status === "unknown") item.degraded = true;
  } catch (e) {
    item.status = "unknown";
    item.degraded = true;
    item.holder = { reason: `持有判定失败：${e.message.split("\n")[0]}` };
  }
  // sqlite 侧（凭据/预算）
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try { Object.assign(item, readSqliteSide(dbPath, db)); } finally { db.close(); }
  } catch (e) {
    item.credentials = { status: "degraded", reason: `库打不开：${e.message.split("\n")[0]}` };
    item.degraded = true;
  }
  // 队列：jobs.json（cron-store）
  if (jobsPath) {
    try {
      const raw = fs.readFileSync(jobsPath, "utf8");
      const jobs = JSON.parse(raw);
      const list = Array.isArray(jobs) ? jobs : (jobs.jobs ?? jobs.tasks ?? []);
      const byState = {};
      for (const j of list) byState[j.state ?? "unknown"] = (byState[j.state ?? "unknown"] ?? 0) + 1;
      item.queue = { source: jobsPath, total: list.length, byState };
    } catch (e) {
      if (e.code === "ENOENT") {
        item.queue = { status: "absent", note: "无 jobs.json（该来源没有 cron-store）" };
      } else {
        item.queue = { status: "degraded", reason: `jobs.json 读不了：${e.message.split("\n")[0]}` };
        item.degraded = true;
      }
    }
  }
  item.collectedAt = now();
  return item;
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
export async function diagnose({ cellsRoot } = {}) {
  const out = { generatedAt: now(), sources: [], skipped: [], degradedCount: 0 };
  const root = cellsRoot ?? process.env.FD_CELLS_ROOT ?? (fs.existsSync("/data/cells") ? "/data/cells" : null);
  // pod 级库（platform 自己的）
  out.sources.push(await diagnoseDb("platform", path.join(storeDir("data"), "app.db"), path.join(storeDir("cron-store"), "jobs.json")));
  // cell 级
  if (root && fs.existsSync(root)) {
    for (const name of fs.readdirSync(root).sort()) {
      const cellRoot = path.join(root, name);
      if (!fs.statSync(cellRoot).isDirectory()) continue;
      const dbPath = path.join(cellRoot, "data", "data", "app.db");
      const jobsPath = path.join(cellRoot, "data", "cron-store", "jobs.json");
      if (!fs.existsSync(dbPath) && !fs.existsSync(jobsPath)) {
        out.skipped.push({ cell: name, reason: "目录下既无状态库也无 cron-store（不满足「持有自身状态库」）" });
        continue;
      }
      out.sources.push(await diagnoseDb(`cell:${name}`, dbPath, jobsPath));
    }
  } else {
    out.cellsRootNote = root ? `${root} 不存在` : "未指定 cells 根（--cells-root / FD_CELLS_ROOT / /data/cells 三处都没有）";
  }
  out.degradedCount = out.sources.filter((s) => s.degraded).length;
  const readable = out.sources.filter((s) => s.status !== "missing" || s.queue || s.credentials).length;
  out.readableSources = out.sources.filter((s) => s.status !== "missing").length;
  return { out, readable, total: out.sources.length };
}

// ── CLI ────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("diagnose-platform-state.mjs")) {
  const cellsRoot = process.argv.includes("--cells-root") ? process.argv[process.argv.indexOf("--cells-root") + 1] : undefined;
  const { out, readable, total } = await diagnose({ cellsRoot });
  console.log(JSON.stringify(out, null, 2));
  if (readable === 0 && total > 0 && out.sources.every((s) => s.status === "missing")) {
    console.error("错误：没有任何可读来源（既无平台库也无 cell 库）");
    process.exit(1);
  }
  process.exit(out.degradedCount > 0 ? 2 : 0);
}
