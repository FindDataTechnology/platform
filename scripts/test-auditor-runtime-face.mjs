#!/usr/bin/env node
// ── Auditor runtime face (harden-auditor-runtime-face 2.x / 4.x) ─────────────
//
// The auditor's MCP face is derived on the server and handed to both narrowing
// layers. This file pins the two things that can silently regress:
//
//   1. WHICH posts get it — auditor posts only. The same preset may hold an
//      auditor post in one fleet and an ordinary post in another, so the branch
//      keys on the member row, never on the preset.
//   2. WHAT happens when the face is unusable — fall back to the pre-change
//      composition (null ⇒ no narrowing) and stay visible, never "narrow to
//      nothing" (a dead watchdog) and never "grant everything" silently.
//
// Background: before this, a custom-preset auditor composed the full baseline.
// Live 2026-11-12 it carried 12 servers including cron_create / pack_publish /
// delegate_task / submit_proposal / memory_write_page, while the spec claimed
// it held read tools only.
//
//   node --test scripts/test-auditor-runtime-face.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { memberFaceFor, auditorFacesByPreset } = await import(path.join(here, "../dsh-profile.js"));
const { auditorMcpFace, AUDITOR_TOOL_FACE, AUDITOR_IN_SERVICE_TOOLS } = await import(
  path.join(here, "../lib/auditor-tool-face.js")
);

const FACE = auditorMcpFace();

test("1. an auditor post composes with the derived face, whatever its preset", () => {
  const faceForPreset = memberFaceFor({ targetKind: "auditor", auditorFace: FACE });
  assert.equal(typeof faceForPreset, "function");
  // The preset id is irrelevant for an auditor — that is the point: it does not
  // matter whether the preset declares anything or belongs to a pack.
  for (const preset of ["user-preset-8", "inv-grade-auditor", "anything-else"]) {
    assert.deepEqual(faceForPreset(preset), FACE);
  }
});

test("2. the auditor face covers exactly the servers the derived map names", () => {
  const faceForPreset = memberFaceFor({ targetKind: "auditor", auditorFace: FACE });
  const face = faceForPreset("user-preset-8");
  assert.deepEqual(Object.keys(face).sort(), Object.keys(AUDITOR_TOOL_FACE).sort());
  for (const server of Object.keys(face)) {
    assert.deepEqual(face[server], [...AUDITOR_TOOL_FACE[server]]);
  }
});

test("3. the face never contains a write surface an auditor must not hold", () => {
  const tools = Object.values(FACE).flat();
  for (const forbidden of [
    "cron_create", "cron_update", "cron_delete", "cron_pause",
    "pack_publish", "pack_visibility", "pack_curation",
    "delegate_task", "submit_proposal", "memory_write_page",
    "bill_event", "run_reconciliation", "actions", "propose_action",
  ]) {
    assert.equal(tools.includes(forbidden), false, `${forbidden} 不得进入审计官面`);
  }
});

test("4. an in-service auditor post keeps every tool it calls each round", () => {
  // 评测舰队 `审计岗`（生产、每日 cadence）：fleet_list → fleet_turns_read → report_status。
  // 任何一个缺了，收窄上线就会当场打断一个正在跑的岗位。
  const tools = new Set(Object.values(FACE).flat());
  for (const needed of AUDITOR_IN_SERVICE_TOOLS) {
    assert.ok(tools.has(needed), `在役审计岗需要 ${needed}，面里没有`);
  }
});

test("5. an ordinary post keeps the packs derivation (byte-for-byte pre-change path)", () => {
  const installedPacks = [
    {
      manifest: {
        mcpServers: [{ registryName: "fd-quant", allowTools: ["list_pending_decisions"] }],
        agents: [{ id: "grade-evaluator", resources: { mcpServers: ["fd-quant"] } }],
      },
    },
  ];
  const faceForPreset = memberFaceFor({ targetKind: "persona", installedPacks });
  assert.deepEqual(faceForPreset("grade-evaluator"), { "fd-quant": ["list_pending_decisions"] });
  // Nothing declared ⇒ null ⇒ the writer's safety valve keeps the full composition.
  assert.equal(faceForPreset("no-such-preset"), null);
});

test("6. an ordinary post with no pack snapshot does not narrow at all", () => {
  const faceForPreset = memberFaceFor({ targetKind: "persona", installedPacks: null });
  assert.equal(faceForPreset, null);
});

test("7. a missing/empty auditor face falls back — never narrow-to-nothing, never widen", () => {
  for (const bad of [null, undefined, {}, "nope", []]) {
    assert.equal(
      memberFaceFor({ targetKind: "auditor", auditorFace: bad }),
      null,
      `不合用的面（${JSON.stringify(bad)}）必须回落，而不是下发空面`,
    );
  }
});

test("8. the same preset narrows as an auditor and does not as an ordinary post", () => {
  // 这是本能力的核心不变量：判定看岗位行，不看预设名。
  const installedPacks = [
    {
      manifest: {
        mcpServers: [{ registryName: "fd-quant", allowTools: ["list_pending_decisions"] }],
        agents: [{ id: "user-preset-8", resources: { mcpServers: ["fd-quant"] } }],
      },
    },
  ];
  const asAuditor = memberFaceFor({ targetKind: "auditor", auditorFace: FACE, installedPacks });
  const asPersona = memberFaceFor({ targetKind: "persona", auditorFace: FACE, installedPacks });
  assert.deepEqual(Object.keys(asAuditor("user-preset-8")).sort(), Object.keys(AUDITOR_TOOL_FACE).sort());
  assert.deepEqual(asPersona("user-preset-8"), { "fd-quant": ["list_pending_decisions"] });
  assert.notDeepEqual(asAuditor("user-preset-8"), asPersona("user-preset-8"));
});

// ── 9-10. 两层必须同一时刻写（2026-11-18 真机踩到的缺陷） ─────────────────────
//
// writeMemberMcpPatch 组合岗位的服务器级 patch 时会**顺带重写 filter 文档**。
// 若那条路不带 auditorFaces，auditor 的 byPreset 条目就落回 pack 声明
// （评测舰队 pack 只有 report_status + auditor_submit_verdict，缺 decision_queue），
// 而 patch 本身是对的 —— 两层互相打架且各自都"成功"。
//
// 这条不能靠读 server.js 的调用来测（那是易漂的字符串），而是钉住合成函数的
// 不变量：一个 face 传进去，服务器层与工具层必须得到**同一个集合**。

test("9. the server layer and the tool layer derive from one face", () => {
  // 服务器层：faceForPreset 返回什么，trim 就用什么
  const serverLayer = memberFaceFor({ targetKind: "auditor", auditorFace: FACE })("mg-audit");
  // 工具层：同一个 face 进 byPreset
  const toolLayer = auditorFacesByPreset([{ targetKind: "auditor", targetId: "mg-audit" }], FACE)["mg-audit"];
  assert.deepEqual(serverLayer, toolLayer, "两层拿到不同的面 = 线上会互相覆盖");
  assert.deepEqual(Object.keys(serverLayer).sort(), Object.keys(AUDITOR_TOOL_FACE).sort());
});

test("10. a pack declaration for the same preset cannot leak into an auditor's tool layer", () => {
  // 评测舰队 pack 的真实声明（缺 decision_queue，多亏它只是 pack 声明）
  const packFace = { fleet: ["report_status", "auditor_submit_verdict"] };
  const toolLayer = auditorFacesByPreset([{ targetKind: "auditor", targetId: "mg-audit" }], FACE)["mg-audit"];
  assert.notDeepEqual(toolLayer, packFace, "auditor 条目被 pack 声明盖回去了");
  assert.ok(toolLayer.fleet.includes("decision_queue"), "decision_queue 必须在");
});

// ── 11. computeAuditorFaces 必须是模块级（2026-11-18 真机踩到的第二个缺陷） ──
//
// 它被 initDshAgent 的闭包包着时，`ctx.composeMemberMcpPatch`（模块级）看不见它。
// 后果是：boot 写了 auditor 条，然后**任何别的岗位**跑回合都会调
// writeMemberMcpPatch → 内部 writeMcpPatch → 不带 auditorFaces → 把 auditor 条整段
// 抹掉。两层各自都"成功"，线上看到的是被抹掉后的版本。
//
// 这条不能靠跑函数测（作用域错了根本调不到），只能读源码钉形态。

import { readFileSync } from "node:fs";

test("11. computeAuditorFaces is module-level, not a closure inside initDshAgent", () => {
  const src = readFileSync(path.join(here, "../server.js"), "utf8");
  // 模块级：行首无缩进的 function 声明
  assert.match(src, /^function computeAuditorFaces\(\)/m, "必须是模块级 function 声明");
  // 闭包形态（缩进的 const = () => {...}）不允许再出现
  assert.equal(
    /^\s+const computeAuditorFaces = \(\) =>/m.test(src),
    false,
    "不能是 initDshAgent 内的闭包——composeMemberMcpPatch 在模块级，看不见它",
  );
});

test("12. every writeMcpPatch site passes auditorFaces", () => {
  const src = readFileSync(path.join(here, "../server.js"), "utf8");
  const sites = [...src.matchAll(/writeMcpPatch\(\{[^}]*\}/gs)].map((m) => m[0]);
  assert.ok(sites.length >= 3, `只找到 ${sites.length} 处 writeMcpPatch，预期 ≥3`);
  const missing = sites.filter((s) => !s.includes("auditorFaces"));
  assert.deepEqual(missing, [], `这些调用点没带 auditorFaces，会抹掉 auditor 条：\n${missing.join("\n---\n")}`);
});
