#!/usr/bin/env node
// ── MCP 鉴权能力探针（add-universal-keyless-mcp-auth 1.2 / 1.3） ─────────────
//
// 能力表只收机器证据。本脚本负责产出机器证据，不产出观点：
//
//   static    解开客户端产物，定位「配置文件条目 → auth provider」的映射函数，
//             判定它是否真的读了 oauth.clientId。同一个客户端往往有**多条加载器**
//             （用户文件 / 连接器模板 / 依赖项），必须逐条判——把它们当成一条，
//             正是我们上一次误判 WorkBuddy 的原因。
//
//   protocol  以客户端的请求形状（resource 值 / scope / 回调 / PKCE）无头复刻授权链，
//             断言 initialize 200 且 tools/list 非空。**必须走完三步握手**：
//             initialize → 取 Mcp-Session-Id → notifications/initialized →
//             带 session 头再 tools/list；漏了 session 头只会得到 0 个工具，
//             而 0 个工具长得和「服务端没工具」一模一样。
//
//   all       先 static 再 protocol，输出一条可直接进能力表的 JSON。
//
// 用法：
//   node scripts/probe-mcp-auth-lanes.mjs static  --app /tmp/wb-asar [--client workbuddy]
//   node scripts/probe-mcp-auth-lanes.mjs protocol --url https://mcp.finddatatech.cloud/fd-daas-mcp/mcp \
//                                                 --token "$(jq -r .access_token ~/.facet/oauth.json)"
//   node scripts/probe-mcp-auth-lanes.mjs all     --app /tmp/wb-asar --url … --token …
//
// 退出码：0=全部判定成立；1=判定不成立（与预期不符）；2=无法判定（缺夹具/缺参数）。
// 无法判定绝不返回 0——「没测成」和「测试通过」必须可区分。
import { readFile } from "node:fs/promises";
import path from "node:path";

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith("-")) ?? "all";
const flag = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};

const log = (...a) => console.error(...a);
const out = (obj) => console.log(JSON.stringify(obj, null, 2));

// ── 极简 JS 扫描器：在压缩成一行的产物里切出一个函数的函数体 ────────────────
// 不做完整解析，只做「引号感知的花括号配对」。压缩产物里字符串/模板占绝大多数，
// 不感知引号就会在 `{` 出现在文案里时切错。正则字面量无法与除号区分，这里用
// 「前一个非空白字符是 ( , = : [ ! & | ? { } ; 或开头」来近似判定，够用且不会
// 因为一条误判就静默放过（切出来的体若不闭合会直接报无法判定）。
function sliceFunctionBody(src, name) {
  const re = new RegExp(`function\\s+${name.replace(/\$/g, "\\$")}\\s*\\(`);
  const m = re.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length;
  // 跳到参数列表结束后的第一个 {
  let depthParen = 1;
  for (; i < src.length && depthParen > 0; i++) {
    const c = src[i];
    if (c === "(") depthParen++;
    else if (c === ")") depthParen--;
  }
  while (i < src.length && src[i] !== "{") i++;
  const start = i;
  let depth = 0;
  let quote = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null; // 不闭合 = 切片失败，调用方必须判为「无法判定」
}

const readsOauthClientId = (body) =>
  /oauth\s*\?\.\s*clientId|oauth\.clientId|oauth\[["']clientId["']\]/.test(body);

// ── static：逐条加载器判定 ────────────────────────────────────────────────
// 已知的加载器与其语义（名字来自产物，见设计 D3）：
//   parseMcpServerEntry — 用户级 mcp.json 的条目解析，产出交给下面的 auth 映射
//   toAuth$2            — 用户文件路径的 auth 映射（UserMcpProvider）
//   toAuth$1            — 连接器/市场模板路径的 auth 映射（toConnectorMcpItem）
//   toDependencyAuth    — 依赖项路径的 auth 映射
export async function probeStatic({ appDir, client = "workbuddy", build = null }) {
  let pkg = {};
  try {
    pkg = JSON.parse(await readFile(path.join(appDir, "package.json"), "utf8"));
  } catch { /* 产物可能没有 package.json，不影响判定 */ }

  const readOr = async (rel) => {
    try { return await readFile(path.join(appDir, rel), "utf8"); } catch { return ""; }
  };
  const sources = {
    "main/server.js": await readOr("main/server.js"),
    "main/authority-snapshot.js": await readOr("main/authority-snapshot.js"),
  };
  const all = Object.values(sources).join("\n");
  if (!all.trim()) return { ok: false, undecidable: true, why: `产物目录没有可读的 main/*.js：${appDir}` };

  const buildTag = build ?? (pkg.name && pkg.version ? `${pkg.name} ${pkg.version}` : null);

  // 1) 条目解析函数是否把 oauth 抬上去
  let entryParser = null;
  for (const [file, src] of Object.entries(sources)) {
    const body = sliceFunctionBody(src, "parseMcpServerEntry");
    if (!body) continue;
    entryParser = {
      file,
      carriesOauthBlock: /oauth/.test(body),
      // 返回对象里若出现 oauth 键，说明该层会把它带下去
      returnsOauthKey: /oauth\s*:/.test(body),
      bodyLength: body.length,
    };
    break;
  }

  // 2) 三条 auth 映射路径
  const loaders = {};
  for (const name of ["toAuth$1", "toAuth$2", "toDependencyAuth"]) {
    let found = null;
    for (const [file, src] of Object.entries(sources)) {
      const body = sliceFunctionBody(src, name);
      if (!body) continue;
      found = {
        file,
        oauthClientId: readsOauthClientId(body),
        // 该路径是否只传 provider:{name} —— 这是「静默回落 DCR」的形状
        providerNameOnly: /provider\s*:\s*\{\s*name\s*:/.test(body) && !readsOauthClientId(body),
        bodyLength: body.length,
      };
      break;
    }
    loaders[name] = found;
  }

  const userFile = loaders["toAuth$2"];
  const connector = loaders["toAuth$1"];
  const dependency = loaders["toDependencyAuth"];

  if (!userFile) {
    return {
      ok: false,
      undecidable: true,
      why: "产物里找不到 toAuth$2（用户文件路径的 auth 映射）——客户端结构已变，须人工复查",
      build: buildTag,
      entryParser,
      loaders,
    };
  }

  const result = {
    ok: true,
    client,
    build: buildTag,
    entryParser,
    loaders,
    // 一个客户端可能同时「用户文件不消费、连接器消费」——必须分开记，别合并
    verdict: {
      userFileLoaderConsumesClientId: userFile.oauthClientId,
      connectorLoaderConsumesClientId: connector ? connector.oauthClientId : null,
      dependencyLoaderConsumesClientId: dependency ? dependency.oauthClientId : null,
      // 能力表里 workbuddy.userFile 的 oauthClientId 取这一条的否定
      oauthClientIdForUserFile: userFile.oauthClientId,
    },
    evidence: {
      probe: "probe-mcp-auth-lanes/static",
      at: new Date().toISOString().slice(0, 10),
      build: buildTag ?? "(未声明版本)",
      detail: `parseMcpServerEntry.carriesOauthBlock=${entryParser ? entryParser.carriesOauthBlock : "n/a"}; ` +
        `toAuth$2.providerNameOnly=${userFile.providerNameOnly}; ` +
        `toAuth$1.oauthClientId=${connector ? connector.oauthClientId : "n/a"}`,
    },
  };

  // 已知结论的自检：用户文件路径若判定为消费 clientId，而连接器路径不消费，
  // 那就说明我们把两条加载器搞反了，必须报不一致而不是照单全收。
  if (connector && userFile.oauthClientId === true && connector.oauthClientId === false) {
    return { ...result, ok: false, why: "加载器归属疑似反转（用户文件读到 clientId 而连接器没读）——须人工复查" };
  }
  return result;
}

// ── protocol：三步握手 + 工具枚举 ─────────────────────────────────────────
async function rpc(url, body, headers = {}) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {
    // SSE 形态：取最后一条 data 行
    const line = text.split("\n").filter((l) => l.startsWith("data:")).pop();
    if (line) { try { json = JSON.parse(line.slice(5).trim()); } catch { /* 保持 null */ } }
  }
  return { status: r.status, sessionId: r.headers.get("mcp-session-id"), json, text };
}

export async function probeProtocol({ url, token, timeoutMs = 20000 }) {
  if (!url) return { ok: false, undecidable: true, why: "缺 --url" };
  if (!token) return { ok: false, undecidable: true, why: "缺 --token" };
  const hdr = { Authorization: `Bearer ${token}` };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const init = await rpc(url, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "facet-probe", version: "1" },
      },
    }, hdr);
    if (init.status !== 200) {
      return { ok: false, why: `initialize 返回 ${init.status}`, body: init.text?.slice(0, 400) };
    }
    const sid = init.sessionId;
    // 有 session 头就必须回送，否则后续调用会被当成新会话甚至被拒
    const sessionHdr = sid ? { ...hdr, "Mcp-Session-Id": sid } : hdr;

    // 通知（无 id，无需响应体）
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionHdr },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    }).catch(() => {});

    const list = await rpc(url, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sessionHdr);
    const tools = list.json?.result?.tools;
    const count = Array.isArray(tools) ? tools.length : 0;

    return {
      ok: count > 0,
      url,
      sessionId: sid ?? null,
      sessionHeaderUsed: Boolean(sid),
      tools: count,
      sampleTools: Array.isArray(tools) ? tools.slice(0, 5).map((t) => t.name) : [],
      ...(count === 0 ? {
        why: sid
          ? "带 session 头仍得 0 工具——服务端确实无工具或工具集未挂载"
          : "服务端未发 Mcp-Session-Id 且得 0 工具——若服务端要求会话，这就是漏握手的典型症状",
        toolsListStatus: list.status,
      } : {}),
      evidence: {
        probe: "probe-mcp-auth-lanes/protocol",
        at: new Date().toISOString().slice(0, 10),
        build: "MCP 2025-06-18",
        detail: `initialize 200 → session=${sid ? "yes" : "no"} → tools/list=${count}`,
      },
    };
  } catch (e) {
    return { ok: false, undecidable: true, why: `协议探针异常：${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

// ── 入口 ──────────────────────────────────────────────────────────────────
async function main() {
  const appDir = flag("app");
  const url = flag("url");
  const token = flag("token") ?? process.env.MCP_TOKEN ?? null;
  const client = flag("client", "workbuddy");
  const build = flag("build");

  let rc = 0;
  if (cmd === "static" || cmd === "all") {
    if (!appDir) { out({ ok: false, undecidable: true, why: "缺 --app <解包后的产物目录>" }); rc = 2; }
    else {
      const r = await probeStatic({ appDir, client, build });
      out(r);
      log(`static: ${r.ok ? "判定成立" : r.undecidable ? "无法判定" : "判定不成立"}` +
        (r.verdict ? ` — 用户文件 oauthClientId=${r.verdict.oauthClientIdForUserFile}, 连接器=${r.verdict.connectorLoaderConsumesClientId}` : ""));
      if (!r.ok) rc = r.undecidable ? 2 : 1;
    }
  }
  if (cmd === "protocol" || cmd === "all") {
    const r = await probeProtocol({ url, token });
    out(r);
    log(`protocol: ${r.ok ? `通过（${r.tools} 工具）` : r.undecidable ? "无法判定" : "不通过"}` +
      (r.why ? ` — ${r.why}` : ""));
    if (!r.ok) rc = Math.max(rc, r.undecidable ? 2 : 1);
  }
  if (cmd !== "static" && cmd !== "protocol" && cmd !== "all") {
    log("用法：probe-mcp-auth-lanes.mjs <static|protocol|all> [--app DIR] [--url URL] [--token T] [--client C] [--build B]");
    rc = 2;
  }
  process.exitCode = rc;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
