#!/usr/bin/env node
// ── 门 K 换票的**接缝**测试（change converge-line-identity-and-keys 7.1）─────
//
// 为什么要单独一条：这个仓反复吃过的亏是「判定绿了不等于接缝真的调了它」。
// `scripts/test-line-token-exchange.mjs` 证明的是判定与签发；本文件证明装配后的
// 网关里**真的有这条路由、且真的在 cell-proxy 兜底之前**——兜底先解析用户身份，
// 而换票的调用方恰恰没有会话，路由晚一格就是永远的 401。
//
// 复用 `scripts/test-gateway-assembly.mjs` 的子进程模式（GATEWAY_ASSEMBLY_ONLY=1
// 起完整路由面、打印路由表、不绑端口、不起 cell），不另造一套夹具。
//
// 三条判据：
//   1. 开关关闭 → 路由表里没有任何 `/api/lines/` 前缀（路径不存在，不是 404）；
//   2. 只开 wire → 恰好 wire 的两条在册，lex 不在（名单是显式的）；
//   3. 两条都在兜底之前（与 mandate/input-request 两道机器门同一条排序规则）。
//
//   node --test --test-concurrency=1 scripts/test-line-token-exchange-seam.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { generateTestKeyPair } from "../gateway/line-token-exchange.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = path.join(REPO, "scripts", "test-gateway-assembly.mjs");
const MARKER = "__GATEWAY_ASSEMBLY__";
const CHILD_TIMEOUT_MS = 60_000;

// 一份真实可用的私钥（否则"开了开关但没给钥"会走 503 分支，路由仍会挂——
// 但那不是我们要验的形态；这里让配置完整，只留开关这一个变量）。
const { privateKeyPem } = generateTestKeyPair();

async function assemble(extraEnv = {}) {
  const child = spawn(process.execPath, [HARNESS], {
    env: {
      ...process.env,
      GATEWAY_ASSEMBLY_CHILD: "1",
      // 先清掉可能从开发者 .env 继承的换票配置，只留用例给的那份。
      LINE_EXCHANGE_ENABLED: "",
      LINE_EXCHANGE_LINES: "",
      LINE_EXCHANGE_KEY_WIRE: "",
      LINE_EXCHANGE_KEY_LEX: "",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr += b));
  const timer = setTimeout(() => child.kill("SIGKILL"), CHILD_TIMEOUT_MS);
  const code = await new Promise((resolve) => child.on("exit", (c) => resolve(c)));
  clearTimeout(timer);
  assert.equal(code, 0, `assembly child must exit cleanly (code ${code})\n${stderr}`);
  const line = stdout.split("\n").find((l) => l.startsWith(MARKER));
  assert.ok(line, `child must print the route registry\nstderr: ${stderr}`);
  return JSON.parse(line.slice(MARKER.length)).routes;
}

const linesRoutes = (routes) => routes.filter((r) => r.kind === "route" && String(r.path).startsWith("/api/lines/"));

test("开关关闭：装配后的网关里没有 /api/lines/* 这条路径", async () => {
  const routes = await assemble();
  assert.deepEqual(linesRoutes(routes), []);
});

test("只开 wire：恰好两条在册，lex 不在（名单是显式的）", async () => {
  const routes = await assemble({
    LINE_EXCHANGE_ENABLED: "1",
    LINE_EXCHANGE_LINES: "wire",
    LINE_EXCHANGE_KEY_WIRE: privateKeyPem,
  });
  const found = linesRoutes(routes).map((r) => `${r.methods.join("+")} ${r.path}`).sort();
  assert.deepEqual(found, ["get /api/lines/wire/jwks.json", "post /api/lines/wire/token"]);
});

test("换票路由排在 cell-proxy 兜底之前（晚一格就是永远的 401）", async () => {
  const routes = await assemble({
    LINE_EXCHANGE_ENABLED: "1",
    LINE_EXCHANGE_LINES: "wire",
    LINE_EXCHANGE_KEY_WIRE: privateKeyPem,
  });
  const idx = routes.findIndex((r) => r.kind === "route" && r.path === "/api/lines/wire/token");
  assert.ok(idx >= 0, "POST /api/lines/wire/token must be registered");
  // 装配夹具的排序规则：最后一条层是 cell-proxy 兜底。
  assert.ok(idx < routes.length - 1, "the exchange route must precede the cell-proxy catch-all");
  assert.equal(routes[routes.length - 1].kind, "middleware", "the last layer is still the cell-proxy catch-all");
});
