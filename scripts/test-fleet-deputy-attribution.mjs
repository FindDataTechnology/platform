// ── 常务岗身份通道守卫（fix-deputy-attribution-self-report）───────────────────
//
// 这条修复的对象不是"某个工具写错了"，而是一整类**不会报错的遗漏**：回服务端的
// 能力如果没带上岗位坐标，本地一切正常、单舰队也正常，只有两支舰队同时有回合在飞
// 时才 409。2026-11-13 实历：`fix-report-attribution-concurrency` 只接到了
// report_status 与 dispatch_post，deputy 三件工具 + auditor + escalate 一处没接，
// 于是 9 个常务岗在错开节奏下全部拒收、零裁决，而所有既有用例都是绿的。
//
// 所以这里有两层：
//   ① 纯函数层：身份怎么并进 body（withSelfIdentity 住 fleet-mcp-hints.js，
//      因为 fleet-mcp.js 顶层 await connect，测试 import 不进来）；
//   ② 源码层：单一出口守卫——fleet-mcp.js 里除 bridgePost 内部不得直呼
//      fetchWithTimeout，且每个 bridgePost 调用点必须把本次调用的 args 传进去。
//      第 ② 层是"下次新增能力忘了带身份"的唯一拦截点。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { withSelfIdentity, selfIdentityFrom, FLEET_IDENTITY_ARG } from "../server/fleet-mcp-hints.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MCP_SRC = readFileSync(join(ROOT, "server/fleet-mcp.js"), "utf8");

const IDENT = { fleetId: "fleet_1", memberId: "m_1", persona: "user.preset-9" };

test("withSelfIdentity: 中继注入的身份并进 body", () => {
  const got = withSelfIdentity({ itemId: "d1", kind: "approve" }, { [FLEET_IDENTITY_ARG]: IDENT });
  assert.deepEqual(got.selfIdentity, IDENT);
  assert.equal(got.itemId, "d1", "业务字段原样保留");
});

test("withSelfIdentity: 没有身份时不多出一个空键", () => {
  const got = withSelfIdentity({ itemId: "d1" }, {});
  assert.equal(Object.hasOwn(got, "selfIdentity"), false);
  assert.deepEqual(got, { itemId: "d1" });
});

test("withSelfIdentity: 调用方自带的同名键不能顶掉注入的身份", () => {
  // 中继已经把 arguments 里自带的 __fleetIdentity 剥掉了；这里是第二道保险——
  // 即便 body 里被塞了一个 selfIdentity，也以 args 里的权威值为准。
  const got = withSelfIdentity({ selfIdentity: { fleetId: "fleet_evil", memberId: "m_evil" } }, {
    [FLEET_IDENTITY_ARG]: IDENT,
  });
  assert.deepEqual(got.selfIdentity, IDENT);
});

test("withSelfIdentity: body 缺省/非对象也不炸", () => {
  assert.deepEqual(withSelfIdentity(undefined, { [FLEET_IDENTITY_ARG]: IDENT }), { selfIdentity: IDENT });
  assert.deepEqual(withSelfIdentity(null, {}), {});
});

test("withSelfIdentity: env 通道（逐 runtime stdio 形态）同样生效", () => {
  const env = { FLEET_MCP_FLEET_ID: "f_env", FLEET_MCP_MEMBER_ID: "m_env" };
  // selfIdentityFrom 默认读 process.env，这里直接验证两处口径一致
  assert.deepEqual(selfIdentityFrom({}, env), { fleetId: "f_env", memberId: "m_env" });
  const got = withSelfIdentity({}, { [FLEET_IDENTITY_ARG]: selfIdentityFrom({}, env) });
  assert.deepEqual(got.selfIdentity, { fleetId: "f_env", memberId: "m_env" });
});

// ── 源码层：单一出口 ─────────────────────────────────────────────────────────

const CALL_RE = /bridgePost\(\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z_$][\w$]*)/g;

/** 每个 bridgePost 调用点的实参列表（括号配平，跳过字符串里的括号）。 */
function bridgeCalls(src) {
  const calls = [];
  for (const m of src.matchAll(CALL_RE)) {
    // 跳过函数声明本身（`async function bridgePost(path, body, rawArgs, …)`）。
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue;
    let i = m.index + m[0].length;
    let depth = 1;
    let quote = null;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
    }
    calls.push({ at: m.index, path: m[1], argsSrc: src.slice(start, i - 1) });
  }
  return calls;
}

/** 顶层逗号切分（跳过括号/字符串内的逗号）。 */
function splitArgs(src) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      cur += c;
      if (c === "\\") { cur += src[++i] ?? ""; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; cur += c; continue; }
    if (c === "{" || c === "[" || c === "(") depth++;
    if (c === "}" || c === "]" || c === ")") depth--;
    if (c === "," && depth === 0) { parts.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.filter(Boolean);
}

test("守卫: fleet-mcp.js 里除 bridgePost 内部以外不得直呼 HTTP 客户端", () => {
  const hits = [...MCP_SRC.matchAll(/fetchWithTimeout\(/g)];
  assert.equal(
    hits.length,
    1,
    `发现 ${hits.length} 处 fetchWithTimeout 直呼：绕过唯一出口就等于丢掉岗位身份，` +
      `并发时该路由必然 409（把新能力改成 bridgePost(path, body, args)）`,
  );
  // 那一处必须在 bridgePost 的函数体里
  const bodyStart = MCP_SRC.indexOf("async function bridgePost(");
  assert.ok(bodyStart > 0, "bridgePost 必须存在");
  assert.ok(hits[0].index > bodyStart, "唯一一处 fetchWithTimeout 必须在 bridgePost 内部");
});

test("守卫: 每个 bridgePost 调用点都传了本次调用的原始参数", () => {
  const calls = bridgeCalls(MCP_SRC);
  assert.ok(calls.length >= 7, `只找到 ${calls.length} 个 bridgePost 调用点，少于预期的 7 条路由`);
  for (const c of calls) {
    const parts = splitArgs(c.argsSrc);
    // argsSrc 从路径字面量之后开始，所以实参是 body [+ rawArgs] [+ options]。
    assert.ok(
      parts.length >= 2,
      `bridgePost(${c.path}) 只传了 ${parts.length} 个实参——缺少 rawArgs，` +
        `岗位坐标带不上去（第 ${MCP_SRC.slice(0, c.at).split("\n").length} 行）`,
    );
    // 三个老工具用 `...rest` 接住剩余参数（含 __fleetIdentity），其余直接用 args。
    assert.ok(
      parts.some((p) => p === "args" || p === "rest"),
      `bridgePost(${c.path}) 没把本次调用的 args/rest 传进去（实参：${parts.join(" | ")}）`,
    );
  }
});

test("守卫: 五个常务岗相关路由都在调用点清单里", () => {
  const paths = bridgeCalls(MCP_SRC).map((c) => c.path.replace(/^["']|["']$/g, ""));
  for (const p of [
    "/api/fleets/report",
    "/api/fleets/escalate",
    "/api/fleets/dispatch",
    "/api/fleets/deputy/queue",
    "/api/fleets/deputy/resolve",
    "/api/fleets/deputy/escalate-to-owner",
    "/api/fleets/auditor/verdict",
  ]) {
    assert.ok(paths.includes(p), `${p} 未经唯一出口（或路径不再是字面量）`);
  }
});

test("守卫: 服务端七处 resolveAttribution 都转发自报身份", () => {
  const src = readFileSync(join(ROOT, "server/routes/fleets.js"), "utf8");
  const lines = src.split("\n");
  const sites = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("resolveAttribution({")) sites.push(i);
  }
  assert.ok(sites.length >= 7, `resolveAttribution 调用点只有 ${sites.length} 处`);
  for (const i of sites) {
    let ok = false;
    for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
      const t = lines[j].trim();
      if (t.startsWith("selfIdentity:")) { ok = true; break; }
      if (t.startsWith("});")) break;
    }
    assert.ok(ok, `第 ${i + 1} 行的 resolveAttribution 没有 selfIdentity —— 并发下这条路由会被 409 拒收`);
  }
});

test("守卫: 七处 resolveAttribution 也都转发回合令牌", () => {
  const src = readFileSync(join(ROOT, "server/routes/fleets.js"), "utf8");
  const lines = src.split("\n");
  const sites = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("resolveAttribution({")) sites.push(i);
  }
  assert.ok(sites.length >= 7);
  for (const i of sites) {
    let token = false;
    let byToken = false;
    for (let j = i + 1; j < Math.min(i + 14, lines.length); j++) {
      const t = lines[j].trim();
      if (t.startsWith("turnToken:")) token = true;
      // 简写属性 `turnByToken,` 与 `turnByToken: …` 都算——前者更短，写起来更不容易漏。
      if (t === "turnByToken," || t.startsWith("turnByToken:")) byToken = true;
      if (t.startsWith("});")) break;
    }
    assert.ok(token && byToken, `第 ${i + 1} 行的 resolveAttribution 缺 turnToken/turnByToken —— worker 车道并发时会退化成 409`);
  }
});
