#!/usr/bin/env node
// ── Blueprint studio reverse assertions (add-blueprint-studio task 6.3) ─────
//
// 反向断言锁：仓库内**不出现**第二校验器 / 第二上架通道 / 第二调度器。
// 静态审计式测试——读 blueprint 三模块的源码原文，钉住它们的接法：
//   ① 校验只许 import 既有三器（parseFleetTemplate / validatePackManifest /
//      publish-tool-gate 同步两函数），不得本地重实现同名语义；
//   ② 上架只许经 facet proxy 的 POST /api/packs 一道门，不得直摸 registry；
//   ③ 三模块不得引入 cron / task-engine / reconcile —— 调度归任务引擎。
// 错误文案粒度由 test-blueprints.mjs「下限规则」一例钉住（既有原文直出）。
//
//   node --test scripts/test-blueprint-reverse-assertions.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
// 结构审计跑在「去注释」的代码上——注释里提到被禁符号不算违约。
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const VALIDATE = "server/blueprint-validate.js";
const ROUTES = "server/routes/blueprints.js";
const DB = "server/routes/blueprints-db.js";

test("6.3 ① 无第二校验器：只 import 既有三器，本地零重实现", () => {
  const src = code(VALIDATE);
  // 接法钉死：三处 import 各就各位。
  assert.match(src, /import \{ parseFleetTemplate \} from "\.\/fleet-template\.js";/);
  // add-agent-builder-workspace 5.1: deriveCode rides the same import (the
  // "no second validator" intent is unchanged — same module, zero reimplementation).
  assert.match(src, /import \{ validatePackManifest(, deriveCode)? \} from "\.\.\/lib\/pack-manifest\.js";/);
  assert.match(
    src,
    /import \{ toolFaceErrors, toolClosureErrors \} from "\.\.\/lib\/publish-tool-gate\.js";/,
  );
  // 不本地重实现同名语义（只有编排器 validateBlueprint 一个合法 "validate" 定义）。
  assert.equal(/function validatePackManifest/.test(src), false);
  assert.equal(/function parseFleetTemplate/.test(src), false);
  assert.equal(/function toolFaceErrors|function toolClosureErrors/.test(src), false);
  const validateDefs = src.match(/function validate\w*\(/g) ?? [];
  assert.deepEqual(validateDefs, ["function validateBlueprint("]);
  // 异步带探针的 toolGateErrors 留在发布门，studio 不调用。
  assert.equal(/toolGateErrors/.test(src), false);
});

test("6.3 ② 无第二上架通道：唯一市场写路径是 facet proxy POST /api/packs", () => {
  const src = code(ROUTES);
  assert.match(src, /import \{ facetRequest \} from "\.\.\/\.\.\/gateway\/facet-proxy\.js";/);
  assert.match(src, /path: "\/api\/packs"/);
  assert.match(src, /method: "POST"/);
  // 不得直摸市场 registry（直写会绕过发布门 collectPublishVerdict 的闸序）。
  assert.equal(/createPackRegistry/.test(src), false);
  assert.equal(/from ".*gateway\/packs\.js"/.test(src), false);
  assert.equal(/registry\.publish/.test(src), false);
});

test("6.3 ③ 无第二调度器：三模块零 cron / 任务引擎 / reconcile 引入", () => {
  for (const rel of [VALIDATE, ROUTES, DB]) {
    const src = code(rel);
    assert.equal(/from ".*\bcron(\.js)?"/.test(src), false, `${rel} must not import cron`);
    assert.equal(/from ".*task-engine/.test(src), false, `${rel} must not import the task engine`);
    assert.equal(/from ".*fleet-reconcile/.test(src), false, `${rel} must not import reconcile`);
    assert.equal(/cron\.schedule|engine\.enqueue|reconcileFleet\(/.test(src), false, `${rel} must not drive scheduling`);
  }
});

test("6.3 ④ 试跑执行器只点火不铸表：用既有 cron 作业，零建/改/删调度", () => {
  const TRIAL = "server/blueprint-trial.js";
  const src = code(TRIAL);
  // 允许：点火既有作业（runJobNow，43430df8 起经 fireJobBounded 有界包裹——
  // cronApi 是注入的 cron 面，直呼 runJobNow 的正则两者都覆盖）、
  // 既有 reconcile、既有装台/装作。
  assert.match(src, /cronApi?\.runJobNow\(/);
  assert.match(src, /reconcileFleet\(/);
  assert.match(src, /provisionFleetFromTemplate\(/);
  assert.match(src, /installPack\(/);
  // 禁止：自建/自改/自删调度，或直连任务引擎入队。
  assert.equal(/cron\.(addJob|updateJob|removeJob)\(/.test(src), false);
  assert.equal(/from ".*task-engine/.test(src), false);
  assert.equal(/engine\.enqueue|enqueueExecution\(/.test(src), false);
});
test("6.3 ⑤ 判据不新造 provider 通道：只复用既有 lane/模型解析", () => {
  const JUDGE = "server/blueprint-judge.js";
  const src = code(JUDGE);
  // 必须复用既有车道与 provider 解析。
  assert.match(src, /from "\.\/llm-lane\.js"/);
  assert.match(src, /from "\.\.\/llm-providers\.js"/);
  assert.match(src, /laneKeyFor\(/);
  // 不得自建 provider/凭证表或直读环境里的密钥拼表。
  assert.equal(/new Map\(\).*provider/i.test(src), false);
  assert.equal(/readProvidersDoc/.test(src), false);
  // 只打 /chat/completions 一个端点（与聊天同源，不新造通道）。
  const endpoints = [...src.matchAll(/\/chat\/completions/g)];
  assert.equal(endpoints.length, 1);
});
