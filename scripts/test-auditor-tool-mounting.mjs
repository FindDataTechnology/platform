// 声明必须已挂载：审计官工具面里的每个名字都要真的存在（2026-11-10）
//
// 起因：AUDITOR_ALLOWED_TOOLS 里曾有三个名字在系统里根本不存在（memory_read /
// memory_overview 写错、report_read 从来没有）。允许清单能保存、能展示，运行时
// 一个都调不到，且零报错——审计官拿着空工具面上岗。
//
// 这条测试扫各 MCP 服务的源码，逐个核对 `name: "<tool>"` 是否真的定义过。
// 新增允许工具时，它要么已挂载，要么这条测试红。
//
// Run: node --test scripts/test-auditor-tool-mounting.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { AUDITOR_ALLOWED_TOOLS } from "../lib/auditor-tool-face.js";

const REPO = new URL("../", import.meta.url).pathname;

// 审计官可见的三个面：本仓的两个 MCP 子进程 + 记忆服务（跨仓，可选）
//
// 记忆服务是跨仓的：它的源码在 fd-memory 仓，位置随检出布局而变（规范树里是
// <workspace>/paas 的同级，本仓的独立 clone 里同级没有）。所以这里**逐个候选
// 路径去找**，找到才核对名字；一个都找不到时把那些名字标为「无法验证」而不是
// 「不存在」——2026-11-10 实测：`memory_query`/`memory_recent`/`memory_overview`
// 在 fd-memory/src/mcp.ts 里都有定义（生产文档亦有实测记录），而本 clone 的同级
// 没有该仓，于是这条测试报「零定义」，把路径问题伪装成产品缺陷。
const FD_MEMORY_CANDIDATES = [
  process.env.FD_MEMORY_ROOT && `${process.env.FD_MEMORY_ROOT.replace(/\/+$/, "")}/src/mcp.ts`,
  `${REPO}../fd-memory/src/mcp.ts`, // 规范树：<workspace>/paas 的同级
  `${REPO}../../fd-memory/src/mcp.ts`, // 独立 clone：<workspace>/code/paas-x 的上两级
  "/Users/chengsishi/finddata/fd-memory/src/mcp.ts",
].filter(Boolean);
const fdMemoryPath = FD_MEMORY_CANDIDATES.find((p) => existsSync(p)) ?? null;

const SURFACES = [
  { name: "fleet-mcp", path: `${REPO}server/fleet-mcp.js`, required: true },
  { name: "fleet-architect-mcp", path: `${REPO}server/fleet-architect-mcp.js`, required: true },
  { name: "fd-memory", path: fdMemoryPath, required: false },
];

function mountMap() {
  const out = new Map();
  for (const surface of SURFACES) {
    if (!existsSync(surface.path)) continue;
    const src = readFileSync(surface.path, "utf8");
    for (const m of src.matchAll(/name:\s*"([a-z0-9_]+)"/g)) {
      if (!out.has(m[1])) out.set(m[1], []);
      out.get(m[1]).push(surface.name);
    }
  }
  return out;
}

test("every allowlisted auditor tool is actually mounted on some surface", () => {
  const mounted = mountMap();
  // 跨仓面缺席时，属于它的名字只能标「无法验证」——不能断言「不存在」：
  // 后者是一条关于产品的错误结论，而真相只是本机没检出那个仓。
  // 缺哪个面就从它的路径候选/环境变量上说清楚该去哪儿找。
  if (!fdMemoryPath) {
    const unverifiable = AUDITOR_ALLOWED_TOOLS.filter((t) => !mounted.has(t) && /^memory_/.test(t));
    assert.deepEqual(
      unverifiable,
      [],
      `记忆服务（fd-memory）在本机没找到，无法验证这些名字是否已挂载：\n` +
        unverifiable.map((t) => `  · ${t}`).join("\n") +
        `\n候选路径：\n` +
        FD_MEMORY_CANDIDATES.map((p) => `  · ${p}`).join("\n") +
        `\n修法：检出 fd-memory 到上述任一位置，或设 FD_MEMORY_ROOT=<fd-memory 仓根>。\n` +
        `注意这**不是**「工具不存在」——是测试看不到定义它的那个仓。`,
    );
  }
  const missing = AUDITOR_ALLOWED_TOOLS.filter((t) => !mounted.has(t));
  assert.deepEqual(
    missing,
    [],
    `以下工具在允许清单里，但没有任何 MCP 服务定义它——审计官会拿到一张空工具面：\n` +
      missing.map((t) => `  · ${t}`).join("\n") +
      `\n要么把它挂上（server/*.js 里 name: "<tool>"），要么从 AUDITOR_ALLOWED_TOOLS 里删掉。`,
  );
});

test("the mounting scan actually reads the surfaces (guards against a silently empty scan)", () => {
  // 自检：扫描若失效（路径改了、正则坏了），上面那条会「零缺失」地假绿。
  const mounted = mountMap();
  assert.ok(mounted.size > 10, `扫描只认出 ${mounted.size} 个工具，面可能没读到`);
  assert.ok(mounted.has("auditor_submit_verdict"), "本次刚加的工具应被扫到");
  assert.ok(mounted.has("decision_queue"), "既有工具应被扫到");
});

test("no allowlisted tool is a write verb except the verdict submit", () => {
  const writes = AUDITOR_ALLOWED_TOOLS.filter((t) => t !== "auditor_submit_verdict");
  const offenders = writes.filter((t) =>
    /(^|_)(send|publish|write|delete|create|update|deploy|pause|resume|add|remove|invoke|execute|toggle)(_|$)/.test(t),
  );
  assert.deepEqual(offenders, [], `写类工具不得进审计官面：${offenders.join(", ")}`);
});
