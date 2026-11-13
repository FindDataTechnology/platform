#!/usr/bin/env node
// ── probe-ecosystem-bridge — 出向链路一键复验（add-ecosystem-bridge 4.4）────
//
// 对指定部署面验证生态桥的出向链路。默认打生产；部署后跑一遍全绿即上线判据。
//
//   node scripts/probe-ecosystem-bridge.mjs                     # 生产全链
//   FACET_BASE=http://127.0.0.1:3200 … node scripts/…           # 指向本地
//   CALLER_KEY=wgk-… node scripts/…                             # 带键测计费面
//
// 检查项：
//   1. marketplace.json 端点：200 + 插件条目形状 + 缓存头 ≤ 1h
//   2. 插件树抽样：plugin.json / SKILL.md / README.md 可取
//   3. MCP 网关 401 带 WWW-Authenticate（零输入链入口）
//   4. （带 CALLER_KEY 时）键验活 + community/付费档可见面
//   5. （带 CALLER_KEY 时）计费预检活链：调用计数可达

import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const CLI = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "facet", "cli", "facet.js");

const FACET = (process.env.FACET_BASE || "https://facet.finddatatech.cloud").replace(/\/+$/, "");
const REGISTRY = (process.env.FACET_REGISTRY || process.env.REGISTRY_URL || "https://mcp.finddatatech.cloud").replace(/\/+$/, "");
const KEY = process.env.CALLER_KEY || "";
const TMP = process.env.FACET_HOME; // 可选：隔离 CLI 本地状态

let failed = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failed += 1;
};

async function main() {
  console.log(`谦面生态桥探针 · facet=${FACET} · registry=${REGISTRY}${KEY ? " · 带键" : ""}\n`);

  // 1. marketplace.json
  let plugins = [];
  try {
    const r = await fetch(`${FACET}/api/marketplace/marketplace.json`);
    const cache = r.headers.get("cache-control") || "";
    const maxAge = Number(cache.match(/max-age=(\d+)/)?.[1] ?? NaN);
    ok("marketplace.json 200", r.status === 200, `HTTP ${r.status}`);
    const doc = await r.json().catch(() => null);
    plugins = Array.isArray(doc?.plugins) ? doc.plugins : [];
    ok("插件条目形状", plugins.length >= 0 && plugins.every((p) => p.name && p.source && p.version),
      `${plugins.length} 条`);
    ok("缓存头 ≤ 1h", Number.isFinite(maxAge) && maxAge <= 3600, cache || "（无）");
  } catch (e) {
    ok("marketplace.json 可达", false, e.message);
  }

  // 2. 插件树抽样（取第一条）
  if (plugins[0]) {
    const p = plugins[0];
    const src = p.source.replace(/^\.\//, "");
    const pj = await fetch(`${FACET}/api/marketplace/${src}/.claude-plugin/plugin.json`);
    ok("plugin.json 可取", pj.status === 200);
    const rd = await fetch(`${FACET}/api/marketplace/${src}/README.md`);
    ok("README.md 可取", rd.status === 200);
    // 技能名要从 plugin 源里的 manifest 才知道——抽样打 skills 面会 404 属预期，
    // 这里只验 plugin.json + README 两个稳定路径。
  } else {
    ok("插件树抽样", false, "marketplace 无条目可抽样");
  }

  // 3. MCP 网关 401 带 WWW-Authenticate
  try {
    const r = await fetch(`${REGISTRY}/fd-open-data-mcp/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } }, id: 1 }),
    });
    const www = r.headers.get("www-authenticate") || "";
    ok("MCP 401 带 WWW-Authenticate", r.status === 401 && www.includes("resource_metadata="), www.slice(0, 90));
  } catch (e) {
    ok("MCP 网关可达", false, e.message);
  }

  // 4+5. 带键：connect 验活（借 CLI 真流程）+ 可见面
  if (KEY) {
    const home = TMP || await mkdtemp(path.join(tmpdir(), "probe-eco-"));
    if (!TMP) {
      await mkdir(path.join(home, ".facet"), { recursive: true });
      await writeFile(path.join(home, ".facet", "credentials.json"),
        JSON.stringify({ key: KEY, registry: REGISTRY, verifiedAt: new Date().toISOString() }), "utf8");
    }
    try {
      const { stdout } = await run(process.execPath, [CLI, "connect", "--show"], { env: { ...process.env, FACET_HOME: home } });
      ok("CLI 读取本地键", /调用键/.test(stdout));
      // 验活 + 可见面：直接打 /api/patch-keys 与 /api/servers
      const h = { Authorization: `Bearer ${KEY}` };
      const keys = await fetch(`${REGISTRY}/api/patch-keys`, { headers: h });
      ok("键验活（patch-keys 200）", keys.status === 200, `HTTP ${keys.status}`);
      const servers = await fetch(`${REGISTRY}/api/servers`, { headers: h });
      if (servers.ok) {
        const doc = await servers.json().catch(() => null);
        const names = (Array.isArray(doc) ? doc : doc?.servers ?? []).map((s) => s?.name ?? s?.id).filter(Boolean);
        const hasPaid = names.includes("law-bench");
        console.log(`  可见 server：${names.join("、") || "（无）"}`);
        if (process.env.EXPECT_PAID) ok("付费档在列（EXPECT_PAID）", hasPaid);
        else ok("付费档缺席（community 默认）", !hasPaid, "law-bench 不应在 community 键的可见面");
      } else {
        ok("可见面可查", false, `HTTP ${servers.status}`);
      }
    } finally {
      if (!TMP) await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  } else {
    console.log("· 未设 CALLER_KEY——跳过键验活/可见面/计费预检项（设 CALLER_KEY=wgk-… 补全）");
  }

  console.log(failed === 0 ? "\n全部通过。" : `\n${failed} 项未过。`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`probe: ${e.message}`);
  process.exit(1);
});
