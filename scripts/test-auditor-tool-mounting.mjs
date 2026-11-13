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
const SURFACES = [
  { name: "fleet-mcp", path: `${REPO}server/fleet-mcp.js`, required: true },
  { name: "fleet-architect-mcp", path: `${REPO}server/fleet-architect-mcp.js`, required: true },
  // The memory service lives in a SIBLING repo, so this path only resolves when
  // the checkout sits next to it. In a git worktree elsewhere (e.g.
  // /tmp/paas-land) `../fd-memory` points at /tmp/fd-memory and the three
  // memory_* allowlist entries then read as "never mounted" — a location
  // artefact, not a regression. FD_MEMORY_ROOT lets such a checkout name the
  // real repo; pointing it at the sibling (or symlinking it into place) keeps
  // the guard strict instead of weakening it.
  { name: "fd-memory", path: `${process.env.FD_MEMORY_ROOT ? `${String(process.env.FD_MEMORY_ROOT).replace(/\/+$/, "")}/` : `${REPO}../fd-memory/`}src/mcp.ts`, required: false },
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

// Tools whose only home is an OPTIONAL surface. Declared here on purpose, not
// inferred: when such a surface is absent, those tools are UNVERIFIED rather
// than unmounted. Why this matters — `fd-memory` is a sibling checkout, and CI
// checks out paas alone, so the unconditional check made this file permanently
// red there with a message that says nothing about the auditor's real face
// ("no MCP server defines memory_query"), i.e. exactly the kind of always-red
// that trains people to ignore a gate.
//
// Direction of failure is deliberate: a tool added to AUDITOR_ALLOWED_TOOLS and
// NOT listed here stays REQUIRED, so forgetting this map can only make the gate
// stricter, never blinder.
const OPTIONAL_ONLY = new Map([
  ["memory_query", "fd-memory"],
  ["memory_recent", "fd-memory"],
  ["memory_overview", "fd-memory"],
]);

test("every allowlisted auditor tool is actually mounted on some surface", () => {
  const mounted = mountMap();
  const absentOptional = new Set(
    SURFACES.filter((s) => !s.required && !existsSync(s.path)).map((s) => s.name),
  );
  const unverified = AUDITOR_ALLOWED_TOOLS.filter((t) => absentOptional.has(OPTIONAL_ONLY.get(t)));
  const required = AUDITOR_ALLOWED_TOOLS.filter((t) => !unverified.includes(t));
  if (unverified.length) {
    console.warn(
      `[auditor-tool-mounting] 未核对 ${unverified.length} 个工具（其表层面未检出：` +
        `${[...absentOptional].join(", ")}）：${unverified.join(", ")}`,
    );
  }
  const missing = required.filter((t) => !mounted.has(t));
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
