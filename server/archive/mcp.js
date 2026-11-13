// ── 存档读面 MCP server（stdio）─────────────────────────────────────────────
//
// 把存档的三条读路径暴露成 MCP 工具，让 agent 按需取用，而不是把整库上下文
// 灌进去：
//
//   archive_conversations  列出可读会话（**只含已同意存档的**）
//   archive_messages       取某会话的消息
//   archive_search         全库检索（默认只搜对方发言）
//
// 为什么工具层要再判一次同意：查询层已经过滤了 `agree_state='agree'`，但工具是
// 对外面——agent 拿到的是工具返回值，"返回空数组"与"这个会话没同意存档"在
// agent 眼里是同一件事，前者会让它换个角度再试、后者应当直接停手。所以这里
// 显式拒绝并说明原因，而不是静默空结果。
//
// 只读：三个工具全部只做查询，没有任何写入路径。库是平台写的那一个 sqlite 文件，
// 这里以短语句读，WAL 下安全。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ensureArchiveSchema, getAgreeState } from "./store.js";
import { getMessages, listConversations, search } from "./query.js";

// stdio 通道就是协议本身：stdout 只能出 JSON-RPC。任何日志都必须走 stderr。
console.log = (...args) => console.error(...args);

const MAX_LIMIT = 200;

function clampLimit(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

export const TOOLS = [
  {
    name: "archive_conversations",
    description:
      "列出可读的已存档会话（仅包含客户已同意存档的会话），按最近消息时间倒序。" +
      "用返回的 conversationId 配合 archive_messages 取消息。",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "返回条数上限（默认 30，最大 200）" },
        withMessagesOnly: {
          type: "boolean",
          description: "只列出有消息的会话（默认 true）",
        },
      },
    },
  },
  {
    name: "archive_messages",
    description:
      "取某个已存档会话的消息（按时间正序）。若该会话未同意存档，工具会明确拒绝而不是返回空列表。",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "会话标识" },
        limit: { type: "number", description: "返回条数上限（默认 50，最大 200）" },
        sinceMs: { type: "number", description: "只要这个时间戳（毫秒）之后的消息" },
      },
      required: ["conversationId"],
    },
  },
  {
    name: "archive_search",
    description:
      "在已存档消息里检索。默认只搜对方（客户）发言，避免把本方昨天说过的话当成新需求再答一遍；" +
      "需要连本方一起搜时显式传 scope='all'。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索词" },
        limit: { type: "number", description: "返回条数上限（默认 20，最大 200）" },
        scope: {
          type: "string",
          enum: ["peer", "all"],
          description: "检索范围：peer（默认，仅对方发言）或 all（含本方）",
        },
      },
      required: ["query"],
    },
  },
];

function ok(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(message, detail = {}) {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: message, ...detail }, null, 2) }],
    isError: true,
  };
}

/**
 * 三个工具的实现，与 MCP 传输层解耦——测试直接喂 db 调它，不必起进程。
 *
 * @param {{db: object}} deps
 */
export function createArchiveTools({ db }) {
  if (!db) throw new Error("createArchiveTools 需要 db");

  return {
    tools: TOOLS,
    call(name, args = {}) {
      switch (name) {
        case "archive_conversations":
          return ok({
            conversations: listConversations(db, {
              limit: clampLimit(args.limit, 30),
              withMessagesOnly: args.withMessagesOnly !== false,
            }),
          });

        case "archive_messages": {
          const conversationId = String(args.conversationId || "").trim();
          if (!conversationId) return fail("缺少 conversationId");
          // 显式同意边界：未同意存档的会话，内容不可读。查询层遇到未同意会返回空
          // 数组，但"空"与"没同意"在 agent 眼里是同一件事——前者会促使它换个角度
          // 再试，后者应当直接停手。所以工具层把原因说出来。
          const state = getAgreeState(db, conversationId);
          if (state !== "agree") {
            return fail(
              state === "unknown"
                ? "会话不存在，或同意状态未知（未确认同意的会话内容不可读）"
                : "该会话未同意存档，内容不可读",
              { conversationId, agreeState: state },
            );
          }
          return ok({
            conversationId,
            messages: getMessages(db, {
              conversationId,
              limit: clampLimit(args.limit, 50),
              sinceMs: args.sinceMs ?? null,
            }),
          });
        }

        case "archive_search": {
          const query = String(args.query || "").trim();
          if (!query) return fail("缺少 query");
          const scope = args.scope === "all" ? "all" : "peer";
          return ok({
            query,
            scope,
            results: search(db, { query, limit: clampLimit(args.limit, 20), scope }),
          });
        }

        default:
          return fail(`未知工具：${name}`);
      }
    },
  };
}

/** 每个 transport 一个 Server 实例（SDK 不允许复用同一个实例二次 connect）。 */
export function buildServer({ db }) {
  const impl = createArchiveTools({ db });
  const server = new Server(
    { name: "archive", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: impl.tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params ?? {};
    try {
      return impl.call(name, args);
    } catch (err) {
      return fail(err?.message || "工具执行失败");
    }
  });
  return server;
}

/** 直接执行时的入口（被 import 时不启动）。 */
export function openArchiveDbFromEnv(env = process.env) {
  const file = env.ARCHIVE_DB || "data/archive.db";
  if (file !== ":memory:") mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  ensureArchiveSchema(db);
  return db;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openArchiveDbFromEnv();
  await buildServer({ db }).connect(new StdioServerTransport());
}
