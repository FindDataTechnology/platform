#!/usr/bin/env node
// ── 车道会话体检：一把客户 sk- 走真实入口，验证「握手 → 会话 → 真工具调用」三段都通
//
// 为什么需要它：这条链上失败与成功的**状态码完全同形**。
//   · 车道丢了 mcp-session-id（2026-11-15 的缺陷）：initialize 照样 200 + x-fd-line，
//     只有第三步 tools/call 会 400 `Missing session ID`；
//   · 线侧 /mcp 门是 presence-only（垃圾 bearer 也 200 + 完整握手）：握手 200 证明不了票被认；
//   · 票被认但主体不属于本线：403 `unknown_identity`（这是「票被认出来了」的证据，不是「不认票」）。
// 所以判据只能落在最后一步：**打一个会碰上游的工具，看它返回真数据**。
// 这套配方此前只活在手抄的 shell 里，换个人、隔一周就跑不起来 —— 这里把它固化成可重跑的体检。
//
// 用法（钥匙只读入、绝不打印）：
//   node scripts/verify-lane-session.mjs --base https://<平台入口> --line wire \
//        --key-file /path/to/key [--tool wire_datasets_list] [--json]
//   离线自证（不需要任何线上资源）：
//   node scripts/verify-lane-session.mjs --self-test
//
// 退出码：0 三段全通 / 1 命中（点名断在哪一段）/ 2 判不出（连不上、被墙、缺参数）。

import http from "node:http";
import { readFileSync } from "node:fs";

/** 每条线「会碰上游」的工具：只有它返回真数据才算通车。 */
const DEFAULT_TOOLS = {
  wire: "wire_datasets_list",
  lex: "lex_me",
};

const PROTOCOL_VERSION = "2025-06-18";

function parseArgs(argv) {
  const out = { line: "wire", tool: null, json: false, selfTest: false, timeoutMs: 30_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--line") out.line = argv[++i];
    else if (a === "--base") out.base = argv[++i];
    else if (a === "--key-file") out.keyFile = argv[++i];
    else if (a === "--key-env") out.keyEnv = argv[++i];
    else if (a === "--tool") out.tool = argv[++i];
    else if (a === "--timeout-ms") out.timeoutMs = Number(argv[++i]);
    else if (a === "--json") out.json = true;
    else if (a === "--self-test") out.selfTest = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}

function readKey(args) {
  if (args.keyFile) return readFileSync(args.keyFile, "utf8").trim();
  if (args.keyEnv) return String(process.env[args.keyEnv] ?? "").trim();
  return "";
}

/** 从 SSE 正文里取第一条能解析的 data 行（streamable-http 的响应可以是事件流）。 */
function firstSseJson(text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      return JSON.parse(line.slice(5).trim());
    } catch {
      // 不是 JSON 的 data 行（注释、心跳）跳过
    }
  }
  return null;
}

async function postJson(url, { key, sessionId, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    // 两个都接受：线侧可能回 JSON，也可能回事件流。
    accept: "application/json, text/event-stream",
  };
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
    headers["mcp-protocol-version"] = PROTOCOL_VERSION;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "manual",
    });
    const text = await res.text();
    const ctype = res.headers.get("content-type") ?? "";
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = /event-stream/i.test(ctype) ? firstSseJson(text) : null;
    }
    return {
      status: res.status,
      fdLine: res.headers.get("x-fd-line"),
      sessionId: res.headers.get("mcp-session-id"),
      ctype,
      json,
      text,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 三段判定。返回 `{ code, reason, detail }`：code 0 通、1 命中、2 判不出。
 *
 * 分成一段一段判而不是只看最后一个状态码：这条链上三种失败同形，只有把「断在哪一段」
 * 说出来，读的人才知道该改车道、改票、还是改主体的归属。
 */
export function judgeLaneSession({ init, call }) {
  if (!init) return { code: 2, reason: "unreachable", detail: "握手请求没有拿到任何响应（网络/入口/DNS）" };
  if (init.status !== 200) {
    const laneError = init.json?.error;
    // 车道自己的三态（401 missing_credential / 401 invalid_key / 503 upstream_unresolved）
    // 与「线侧拒绝了票」不是一回事，照原文给出来。
    return {
      code: 1,
      reason: laneError ? `lane_${laneError}` : "initialize_failed",
      detail: `initialize HTTP ${init.status}${laneError ? ` ${laneError}` : ""}`,
    };
  }
  if (!init.sessionId) {
    return {
      code: 1,
      reason: "session_header_missing",
      detail:
        "initialize 200 但响应头没有 mcp-session-id —— 车道没把会话头带回来（或该线是无状态实现）。" +
        "无状态线可以忽略本项，会话式线在这里就已经断了。",
    };
  }
  if (!call) return { code: 2, reason: "unreachable", detail: "tools/call 没有拿到任何响应" };
  if (call.status === 400 && /missing session id/i.test(call.text ?? "")) {
    return {
      code: 1,
      reason: "session_header_not_forwarded",
      detail: "tools/call 400 `Missing session ID` —— 调用方带的会话头没到上游（车道请求方向丢头）",
    };
  }
  if (call.status !== 200) {
    const msg = call.json?.error?.message ?? call.json?.error ?? "";
    const code = call.json?.error?.code;
    const hint =
      /unknown_identity/i.test(String(msg)) || call.status === 403
        ? "（403 unknown_identity = 票被认出来了但主体不属于本线：换本线真实主体，别读成「线不认票」）"
        : "";
    return {
      code: 1,
      reason: "tool_call_failed",
      detail: `tools/call HTTP ${call.status}${code !== undefined ? ` code=${code}` : ""} ${String(msg).slice(0, 160)}${hint}`,
    };
  }
  if (call.json?.error) {
    return {
      code: 1,
      reason: "jsonrpc_error",
      detail: `JSON-RPC error ${call.json.error.code}: ${String(call.json.error.message).slice(0, 160)}`,
    };
  }
  if (!call.json?.result) {
    return { code: 1, reason: "no_result", detail: "tools/call 200 但没有 result（空壳）" };
  }
  if (call.json.result.isError) {
    return {
      code: 1,
      reason: "tool_error",
      detail: `工具自报失败：${JSON.stringify(call.json.result.content ?? call.json.result).slice(0, 200)}`,
    };
  }
  return { code: 0, reason: "ok", detail: "握手 → 会话 → 真工具调用三段全通" };
}

async function runOne({ base, line, key, tool, timeoutMs }) {
  const url = `${base.replace(/\/+$/, "")}/api/lines/${line}/proxy/mcp`;
  let init = null;
  try {
    init = await postJson(url, {
      key,
      timeoutMs,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "lane-session-verify", version: "1" },
        },
      },
    });
  } catch {
    return { url, init: null, call: null, verdict: judgeLaneSession({ init: null, call: null }) };
  }
  if (!init.sessionId || init.status !== 200) {
    return { url, init, call: null, verdict: judgeLaneSession({ init, call: null }) };
  }
  let call = null;
  try {
    call = await postJson(url, {
      key,
      sessionId: init.sessionId,
      timeoutMs,
      body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: {} } },
    });
  } catch {
    call = null;
  }
  return { url, init, call, verdict: judgeLaneSession({ init, call }) };
}

// ── 自证：不需要任何线上资源，四种形态各一条 ────────────────────────────────

function startFake({ mode }) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        body = {};
      }
      if (body.method === "initialize") {
        if (mode === "no_session_header") {
          res.setHeader("content-type", "application/json");
          res.setHeader("x-fd-line", "wire");
          return res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: PROTOCOL_VERSION } }));
        }
        res.setHeader("content-type", "application/json");
        res.setHeader("x-fd-line", "wire");
        res.setHeader("mcp-session-id", "sess-fake");
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: PROTOCOL_VERSION } }));
      }
      if (body.method === "tools/call") {
        // 模拟「车道请求方向丢头」：文件名是 drop_request_header，但本脚本扮演的是**客户端**，
        // 它每次都会带会话头；丢头发生在中间那层。所以这里无条件复现上游的症状——
        // 若写成「没收到头才 400」，判据永远走不到这一档，只会掉进 no_result（假通过）。
        if (mode === "drop_request_header") {
          res.setHeader("content-type", "application/json");
          res.statusCode = 400;
          return res.end(
            JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Bad Request: Missing session ID" } }),
          );
        }
        if (mode === "healthy") {
          res.setHeader("content-type", "application/json");
          res.setHeader("x-fd-line", "wire");
          return res.end(
            JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "{}" }] } }),
          );
        }
      }
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

async function selfTest() {
  const cases = [
    { mode: "healthy", expect: 0, why: "三段全通必须判通（少这条路，「全都判红」与「判据写反」同形）" },
    { mode: "no_session_header", expect: 1, why: "会话头回不来必须命中" },
    { mode: "drop_request_header", expect: 1, why: "调用方带的会话头到不了上游必须命中" },
    { mode: "unreachable", expect: 2, why: "连不上必须判不出，不许当通过" },
  ];
  let bad = 0;
  for (const c of cases) {
    let base = "http://127.0.0.1:1";
    let server = null;
    if (c.mode !== "unreachable") {
      ({ server, base } = await startFake({ mode: c.mode }));
    }
    let got;
    try {
      got = await runOne({ base, line: "wire", key: "sk-selftest", tool: "wire_datasets_list", timeoutMs: 2_000 });
    } finally {
      if (server) await new Promise((r) => server.close(r));
    }
    const code = got.verdict.code;
    const ok = code === c.expect;
    if (!ok) bad += 1;
    console.log(`${ok ? "✓" : "✗"} ${c.mode}: 期望 ${c.expect} 实得 ${code}（${got.verdict.reason}）— ${c.why}`);
  }
  return bad === 0 ? 0 : 1;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String(err.message));
    return 2;
  }
  if (args.help) {
    console.log(
      "用法：verify-lane-session.mjs --base <平台入口> [--line wire] [--key-file <path>|--key-env <VAR>] [--tool <name>] [--json] [--self-test]",
    );
    return 0;
  }
  if (args.selfTest) return selfTest();

  if (!args.base) {
    console.error("缺 --base（平台入口，e.g. https://<host> 或集群内 http://<ClusterIP>:<port>）");
    return 2;
  }
  const key = readKey(args);
  if (!key) {
    console.error("缺钥匙：用 --key-file 或 --key-env 给（脚本只读入，不打印）");
    return 2;
  }
  const tool = args.tool ?? DEFAULT_TOOLS[args.line];
  if (!tool) {
    console.error(`线 ${args.line} 没有默认工具，用 --tool 指定一个「会碰上游」的工具`);
    return 2;
  }

  const got = await runOne({ base: args.base, line: args.line, key, tool, timeoutMs: args.timeoutMs });
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          line: args.line,
          tool,
          url: got.url,
          verdict: got.verdict,
          init: got.init && { status: got.init.status, fdLine: got.init.fdLine, sessionId: Boolean(got.init.sessionId) },
          call: got.call && { status: got.call.status, fdLine: got.call.fdLine, jsonError: got.call.json?.error ?? null },
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`线 ${args.line} · 工具 ${tool}`);
    console.log(`  握手 initialize：${got.init ? `HTTP ${got.init.status} x-fd-line=${got.init.fdLine ?? "-"} 会话头=${got.init.sessionId ? "有" : "无"}` : "无响应"}`);
    console.log(`  调用 tools/call：${got.call ? `HTTP ${got.call.status}` : "未发起"}`);
    console.log(`  判定：${got.verdict.code === 0 ? "✓ 通车" : got.verdict.code === 2 ? "? 判不出" : "✗ 命中"} — ${got.verdict.reason}`);
    console.log(`  ${got.verdict.detail}`);
  }
  return got.verdict.code;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code));
}
