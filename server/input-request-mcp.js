// ── Input-request MCP server (add-input-request-cards, design D2) ────────────
//
// 把 `request_input` 暴露给 dsh 侧的 agent。与 actions-mcp.js 同一个形状：
// 一个极薄的 stdio 子进程 + loopback REST 桥；身份（owner 邮箱、会话 id）由
// 每用户 profile 注入的 env 决定，模型永远不能自己声明「我是谁」。
//
// 与 ask_user_question 的根本区别（这就是整个能力的由来）：挂起点在平台进程
// 里，不在 harness 里。工具只是「提卡 + 长轮询」，所以任何能调 MCP 的运行时
// ——包括没有 userQuestions seam 的 ACP 系——都能问出同一个问题。
//
// 返回给模型的是一个普通工具结果：{ requestId, state, values, answeredBy }。
// 终态含 answered / cancelled / expired / escalated —— 模型按 state 决定继续、
// 放弃还是等主人处理，而不是把"没人答"当成异常。

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export const OWNER_EMAIL_ENV = "INPUT_REQUEST_OWNER_EMAIL";
export const SESSION_ENV = "INPUT_REQUEST_SESSION_ID";

export function ownerEmailFromEnv(env = process.env) {
  const v = String(env[OWNER_EMAIL_ENV] || "").trim().toLowerCase();
  return v || null;
}

export function sessionIdFromEnv(env = process.env) {
  const v = String(env[SESSION_ENV] || env.DSH_SESSION_ID || "").trim();
  return v || null;
}

/** The stdio child's identity: both halves come from the per-user profile. */
export function identityFromEnv(env = process.env) {
  return { ownerEmail: ownerEmailFromEnv(env), sessionId: sessionIdFromEnv(env) };
}

function bridgeOrigin() {
  if (process.env.INPUT_REQUEST_URL) return process.env.INPUT_REQUEST_URL.replace(/\/$/, "");
  const raw = process.env.HOST || "localhost";
  const host = raw === "0.0.0.0" || raw === "::" ? "127.0.0.1" : raw;
  const bracketed = host.includes(":") ? `[${host}]` : host;
  return `http://${bracketed}:${process.env.PORT || 3000}`;
}

// 长轮询专用请求：不套 fetchWithTimeout（它默认 10s，正好会把等待掐断），
// 由平台侧的 wait 端点自己决定单轮多长。
async function call(method, path, body, { timeoutMs = 60_000 } = {}) {
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

const WAIT_ROUND_MS = Number(process.env.INPUT_REQUEST_WAIT_MS) || 25_000;

// 一次工具调用最多在工具内部等多久（见 request_input 里的两段式等待）。默认
// 45s：比 MCP SDK 的 60s 调用超时留出余量，又足够让「人正在看着屏幕」这种
// 最常见的情况在回合内拿到答案。调大它有代价——超过 harness 的调用超时就会
// 变成 Request timed out，那是这个能力最初在线上失败的方式。
function maxWaitMs() {
  const v = Number(process.env.INPUT_REQUEST_MAX_WAIT_MS);
  return Number.isFinite(v) && v > 0 ? v : 45_000;
}

const TOOLS = [
  {
    name: "request_input",
    description:
      "Ask the human for structured input (fill a form, confirm something, pick one option). " +
      "This BLOCKS until they answer, cancel, or the request expires — the returned object always " +
      "carries `state` (answered | cancelled | expired | escalated) plus `values`. " +
      "Use it when you genuinely need information or approval you cannot infer; the card renders on " +
      "whichever surface the user is on (web, miniapp, bot) and degrades by policy when nobody is " +
      "there. Do NOT use it to ask open-ended chat questions — just ask in your reply. " +
      "Field kinds allowed: text, multiline, number, date, enum (needs options), boolean, file.",
    inputSchema: {
      type: "object",
      required: ["card"],
      properties: {
        card: {
          type: "object",
          description: "The card to render.",
          required: ["type", "title"],
          properties: {
            type: {
              type: "string",
              enum: ["form", "confirm", "choice"],
              description:
                "form = fields you describe; confirm = exactly one boolean field; choice = exactly one enum field",
            },
            title: { type: "string" },
            detail: { type: "string", description: "Optional supporting text" },
            fields: {
              type: "array",
              description: "Field list; every field needs key + kind",
              items: {
                type: "object",
                required: ["key", "kind"],
                properties: {
                  key: { type: "string" },
                  label: { type: "string" },
                  kind: {
                    type: "string",
                    enum: ["text", "multiline", "number", "date", "enum", "boolean", "file"],
                  },
                  required: { type: "boolean" },
                  options: {
                    description: "enum only: string list or {value,label} list",
                    type: "array",
                    items: {},
                  },
                  default: { description: "Required when the policy is 'default'" },
                  placeholder: { type: "string" },
                  unit: { type: "string", description: "e.g. 元, 天" },
                },
              },
            },
          },
        },
        policy: {
          type: "object",
          description:
            "Optional. onUnattended: wait | default | abort | escalate (default comes from the team policy). " +
            "ttlSec: how long to wait. Omit to inherit.",
          properties: {
            onUnattended: { type: "string", enum: ["wait", "default", "abort", "escalate"] },
            ttlSec: { type: "number" },
          },
        },
      },
    },
  },
];

// ── 驱动器 ──────────────────────────────────────────────────────────────────
//
// 工具逻辑与「它跑在哪」解耦：stdio 子进程只能走 loopback HTTP；而同一个
// server 在平台进程内被挂成 streamable-http 时，再绕一次 HTTP 会打回错误的
// 端口（测试里就是 3000）。两种驱动器形状完全相同：create / wait / get。

export function httpDriver({ ownerEmail, sessionId }) {
  return {
    async create(args) {
      return call("POST", "/api/input-requests", {
        card: args?.card,
        ...(args?.policy ? { policy: args.policy } : {}),
        ownerEmail,
        sessionId: sessionId ?? null,
      });
    },
    async wait(requestId, roundMs = WAIT_ROUND_MS) {
      // roundMs 让调用方把「总预算剩余」压进单轮：一轮不该跨过 harness 的
      // 调用超时线（压过就是整体失败，而不是「这一轮没结果」）。
      const round = Math.max(1_000, Math.min(roundMs, WAIT_ROUND_MS));
      const settled = await call(
        "GET",
        `/api/input-requests/${encodeURIComponent(requestId)}/wait?timeoutMs=${round}`,
        null,
        { timeoutMs: round + 15_000 },
      );
      return settled?.pending ? null : settled;
    },
    async get(requestId) {
      return call("GET", `/api/input-requests/${encodeURIComponent(requestId)}`);
    },
  };
}

export async function createServer({ identity = identityFromEnv, driverFactory = httpDriver } = {}) {
  const server = new Server(
    { name: "input-request-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name !== "request_input") {
      return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
    }
    const who = identity();
    const ownerEmail = who?.ownerEmail ?? null;
    if (!ownerEmail) {
      // 没有归属就没有人能答（owner-only）。宁可让模型看到一条可解释的失败，
      // 也不要落一行永远匹配不上主人的死记录。
      return {
        content: [
          {
            type: "text",
            text:
              "request_input is not configured for this agent: no owner identity was injected " +
              `(${OWNER_EMAIL_ENV} is empty). Ask in your reply instead.`,
          },
        ],
        isError: true,
      };
    }

    try {
      const driver = driverFactory({ ownerEmail, sessionId: who?.sessionId ?? null });
      const created = await driver.create(args ?? {});

      // 续等直到落终态，但**有上限**：harness 给一次 tools/call 的预算是硬的
      // （MCP SDK 默认 60s，dsh 实测在同一量级——2026-11-11 线上就是被它掐成
      // `Error: Request timed out`，卡片行还 pending，模型却已经收到失败）。
      // 等人填表天然会超过它，所以这里分两段：
      //   · 人在看：答案在窗口内回来 → 工具直接带着答案返回，回合继续（快路）。
      //   · 人不在了：窗口到了就返回 state=pending，由平台在作答后开新回合把
      //     答案送回（design D6 的回灌路径），而不是让 harness 报超时。
      // 窗口留足余量：45s < 60s，且每轮 wait 不超过剩余预算，避免某一轮跨过
      // 调用方的超时线被整体判失败。
      const budget = maxWaitMs();
      const deadline = Date.now() + budget;
      let current = created;
      while (current?.state === "pending") {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const settled = await driver.wait(created.requestId, Math.min(remaining, WAIT_ROUND_MS));
        if (settled) {
          current = settled;
          break;
        }
        // 再读一次状态：可能刚好在这一轮之前被答掉了。
        current = await driver.get(created.requestId);
      }

      const stillPending = current?.state === "pending";
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              requestId: created.requestId,
              state: current?.state ?? "pending",
              values: current?.values ?? null,
              answeredBy: current?.answeredBy ?? null,
              // 挂起中要明说，模型才不会以为「没人理」：卡已经在主人的面上，
              // 作答后答案会作为一条新消息回来。
              ...(stillPending
                ? {
                    awaitingAnswer: true,
                    note:
                      "The card is on the owner's screen; they have not answered yet. " +
                      "End this turn with a short note. When they answer, the platform " +
                      "sends you the filled values as a new message — continue then.",
                  }
                : {}),
            }),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: err.message || "request_input failed" }],
        isError: true,
      };
    }
  });

  return server;
}

async function run() {
  // stdout IS the stdio wire once this transport connects, so a stray log would
  // corrupt the protocol — that is why this redirect exists. It must NOT live at
  // module scope: the platform imports this file too (server/input-request-http.js
  // mounts the same tool over streamable HTTP for ACP harnesses), and a
  // module-level assignment hijacked the PARENT process's console.log, sending
  // every boot line — including `Platform listening at …` — to stderr. Found
  // 2026-11-13: e2e/dsh-matrix-lock.spec.js waits on that line in stdout and hung
  // for its full 2-minute timeout, retried, three times.
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
    console.error("[input-request-mcp] failed to start:", err);
    process.exit(1);
  });
}
