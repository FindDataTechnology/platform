// ── Handoff MCP server (chatwoot-ai-handoff 4.1) ─────────────────────────────
//
// 把 `handoff_to_human` 暴露给 agent。与 input-request-mcp.js 同一个形状：一个
// 极薄的 stdio 子进程 + loopback REST 桥；bot 身份由 profile 注入的 env 决定，
// 模型永远不能自己声明「转给谁」。
//
// 为什么需要这个工具：stop-guard 只负责「人已接手后闭嘴」，它不会让 AI 主动
// 请人。没有这个出口，访客问一个 AI 答不了的问题时只能得到硬答或沉默——
// 这正是本次改造要补的那半。
//
// 触发情形由 agent 判断，但两类必须是**确定性**的（见 tasks.md 4.3）：
//   - 访客明确要求人工（关键词命中，不靠模型自由裁量）
//   - 越权请求（超出该 bot 的授权范围）
// 知识缺口可由模型判断。工具本身不区分这些——它只执行交人，理由写进台账。
//
// 返回给模型的是一个普通工具结果 `{ ok, status, assigneeId }` 或可区分的失败；
// 模型据此决定是继续解释还是直接把话说给访客。
//
// 与 escalateToHuman 的关系：本工具**不自己实现**交人，它调
// `POST /api/bots/:id/escalate`，那个端点再调 `lib/escalate.js`。
// 一份实现、两条触发路径（运维入口 / agent 主动），避免两套语义分叉。

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export const BOT_ID_ENV = "HANDOFF_BOT_ID";
export const SESSION_ENV = "HANDOFF_SESSION_ID";
export const BRIDGE_URL_ENV = "HANDOFF_BRIDGE_URL";

function botIdFromEnv(env = process.env) {
  return String(env[BOT_ID_ENV] || "").trim() || null;
}
// The chat key is NOT injected per turn — the agent's tool call knows only the
// dsh session it runs in. The server resolves session → chatKey with the same
// reverse lookup the input-request lane uses (botChatForSession).
function sessionIdFromEnv(env = process.env) {
  return String(env[SESSION_ENV] || "").trim() || null;
}
function bridgeOrigin(env = process.env) {
  return String(env[BRIDGE_URL_ENV] || "http://127.0.0.1:3000").replace(/\/+$/, "");
}

async function call(method, path, body, { timeoutMs = 20_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${bridgeOrigin()}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = data.details ? `${data.error}: ${JSON.stringify(data.details)}` : data.error;
      throw new Error(reason || `${method} ${path} failed (${res.status})`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

const TOOLS = [
  {
    name: "handoff_to_human",
    description:
      "Hand this conversation to a human agent. Use it when you cannot answer well " +
      "(a knowledge gap), when the visitor explicitly asks for a person, or when the " +
      "request is beyond your authority. After it succeeds, do NOT keep answering in " +
      "this conversation — the human owns it now. Say one short line telling the " +
      "visitor a person will pick it up, then stop. Returns { ok, status, assigneeId } " +
      "or a classified failure (unauthorized / rejected / unreachable / target-unavailable); " +
      "on failure, tell the visitor plainly that you could not reach a human.",
    inputSchema: {
      type: "object",
      required: ["reason"],
      properties: {
        reason: {
          type: "string",
          enum: ["cannot_answer", "visitor_asked", "beyond_authority"],
          description:
            "Why you are handing off. cannot_answer = a knowledge gap; " +
            "visitor_asked = the visitor explicitly asked for a person; " +
            "beyond_authority = the request needs someone with authority you do not have.",
        },
        note: {
          type: "string",
          description:
            "Optional one-line note for the human who picks this up (what the visitor needs). " +
            "Not shown to the visitor.",
        },
      },
    },
  },
];

export function httpDriver({ botId, sessionId }) {
  return {
    async handoff({ reason, note } = {}) {
      if (!botId) throw new Error("handoff: no bot identity was injected");
      if (!sessionId) throw new Error("handoff: no session identity was injected");
      return call("POST", `/api/bots/${encodeURIComponent(botId)}/escalate`, {
        sessionId,
        reason: String(reason ?? ""),
        note: String(note ?? ""),
      });
    },
  };
}

export async function createServer({
  identity = () => ({ botId: botIdFromEnv(), sessionId: sessionIdFromEnv() }),
  driverFactory = httpDriver,
} = {}) {
  const server = new Server(
    { name: "handoff-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name !== "handoff_to_human") {
      return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
    }
    const who = identity();
    const botId = who?.botId ?? null;
    if (!botId) {
      // 没有归属就没有可交的会话。宁可让模型看到一条可解释的失败，
      // 也不要调一条必然被拒的请求、把失败伪装成平台问题。
      return {
        content: [
          {
            type: "text",
            text:
              "handoff_to_human is not available on this surface: no bot identity was injected " +
              `(${BOT_ID_ENV} is empty). Tell the visitor in your reply that a person will follow up.`,
          },
        ],
        isError: true,
      };
    }
    const driver = driverFactory({ botId, sessionId: who?.sessionId ?? null });
    let result;
    try {
      result = await driver.handoff({ reason: args?.reason, note: args?.note });
    } catch (err) {
      return { content: [{ type: "text", text: `handoff failed: ${err.message}` }], isError: true };
    }
    // A platform verdict is an outcome, not a throw — hand it to the model as data
    // so it can say the honest thing to the visitor.
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  return server;
}

async function run() {
  // Same reason as input-request-mcp.js: a stdio child must never let a library
  // write onto stdout — it is the MCP frame channel.
  console.log = (...args) => console.error(...args);
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const launchedDirectly = (() => {
  try {
    return process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (launchedDirectly) {
  run().catch((err) => {
    console.error("[handoff-mcp] failed to start:", err);
    process.exit(1);
  });
}