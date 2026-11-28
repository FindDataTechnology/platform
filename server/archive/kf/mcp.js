// ── 微信客服：agent 工具面（stdio MCP）──────────────────────────────────────
//
// 为什么要有这一层：kf 通道此前的状态是「只入库、没人读」——消息落库、附件抽成了
// 文本、只读 HTTP 面也齐，但 `kfAgentInput` 在生产里零调用者。而「合规留痕/质检」
// 与「商机接住」本质都是 **agent 去读会话**，没有入口就只能靠人跑 CLI。
//
// 形状照抄存档通道的 `server/archive/mcp.js`（同一个 SDK、同样只读、同样把
// `create*Tools({db})` 与传输层解耦，好让用例直接喂 db 调）。
//
// 四条纪律：
//
//   1. **只读**。四个工具全做查询：没有拉取（会发起外部请求）、没有下载（外部副作用）、
//      没有发送（对外动作）。给客户发消息的唯一入口仍是 CLI 的 `reply --confirm`。
//   2. **默认只给客户发言**。`self`/`system`/`unknown` 会污染判断：让 agent 对着
//      「客户已进入会话」写一段回答，是这条通道最早的坑之一。
//   3. **附件正文随消息带出**。kf 的 file 消息正文是空串（官方不给文件名），
//      不补附件就是一条空消息。未抽出来时给 `status` + `reason`，不给空串。
//   4. **stdout 只有 JSON-RPC**。`console.log` 一律重定向到 stderr——stdio 就是协议本身。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createKfDatabase } from "./db.js";
import { kfAgentInput } from "./ingest.js";
import { replyWindow, REPLY_WINDOW_HOURS } from "./reply.js";
import {
  getKfAttachmentText,
  getKfConversation,
  getKfMediaExtractState,
  listKfConversations,
  listKfMessages,
  searchKfMessages,
} from "./store.js";

// stdio 通道就是协议本身：stdout 只能出 JSON-RPC，日志必须走 stderr。
console.log = (...args) => console.error(...args);

export const MCP_LIMITS = {
  conversations: 100,
  messages: 200,
  search: 100,
  attachmentChars: 20000,
};

function clampLimit(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), MCP_LIMITS.messages);
}

export const TOOLS = [
  {
    name: "kf_conversations",
    description:
      "列出微信客服会话（按最近消息倒序），带客户最后发言时间与我方最后回复时间，" +
      "并给出 48 小时回复窗口还剩多久。用返回的 conversationId 配合 kf_messages 取消息。",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "返回条数上限（默认 30，最大 100）" },
      },
    },
  },
  {
    name: "kf_messages",
    description:
      "取某个客服会话的消息（按时间倒序）。**默认只给客户发言**，因为本方回复与系统事件会污染判断。" +
      "客户发来的附件会带出已抽取的正文；未抽取时给出状态与原因。",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "会话标识（形如 openKfId|externalUserId）" },
        limit: { type: "number", description: "返回条数上限（默认 50，最大 200）" },
        includeSelf: {
          type: "boolean",
          description: "同时给出本方回复（默认 false）。系统事件始终不返回。",
        },
      },
      required: ["conversationId"],
    },
  },
  {
    name: "kf_search",
    description:
      "检索客服消息，**同时命中附件正文**（客户发来的报价单/清单里写的内容也能搜到）；" +
      "命中附件时结果会标 matchedIn='attachment'。默认只搜客户发言。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索词" },
        limit: { type: "number", description: "返回条数上限（默认 20，最大 100）" },
        includeSelf: { type: "boolean", description: "连本方回复一起搜（默认 false）" },
      },
      required: ["query"],
    },
  },
  {
    name: "kf_attachment",
    description:
      "取某条消息的附件正文全文（有界）。kf_messages 每条最多带 4000 字符，长表格用它取全文。" +
      "只读已落库的抽取结果：不会去下载，也不会现场解析文件。",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "消息 id（kf_messages 返回的 id）" },
        maxChars: { type: "number", description: "返回字符上限（默认 4000，最大 20000）" },
      },
      required: ["messageId"],
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

/** 会话上补一个「窗口还剩多久」的判断。客户从未发言时不编造窗口。 */
function withWindow(conv, now) {
  const window = replyWindow({ lastCustomerAt: conv.lastPeerAt, now });
  return { ...conv, window: { open: window.open, hoursLeft: window.hoursLeft, reason: window.reason } };
}

/**
 * 四个工具的实现，与 MCP 传输层解耦——用例直接喂 db 调，不必起进程。
 *
 * @param {{db: object, now?: () => number}} deps
 */
export function createKfTools({ db, now = () => Date.now() }) {
  if (!db) throw new Error("createKfTools 需要 db");

  return {
    tools: TOOLS,
    call(name, args = {}) {
      switch (name) {
        case "kf_conversations": {
          const t = now();
          const conversations = listKfConversations(db, {
            limit: clampLimit(args.limit, 30),
          }).map((c) => withWindow(c, t));
          return ok({ conversations, replyWindowHours: REPLY_WINDOW_HOURS });
        }

        case "kf_messages": {
          const conversationId = String(args.conversationId || "").trim();
          if (!conversationId) return fail("缺少 conversationId", { field: "conversationId" });

          const limit = clampLimit(args.limit, 50);
          const conversation = getKfConversation(db, conversationId);
          if (!conversation) {
            // 明确说「没有这个会话」而不是空数组：空数组会让 agent 换个角度重试。
            return fail("没有这个会话", { conversationId });
          }

          // 默认走 kfAgentInput：它已经做了"只留 peer"与"给附件挂正文"两件事，
          // 再写一遍就是第二份口径。要本方发言时单独查，但系统事件仍然丢。
          const messages = args.includeSelf
            ? listKfMessages(db, {
                conversationId,
                limit,
                origins: ["peer", "self"],
              }).map((m) => withAttachment(db, m))
            : kfAgentInput(db, { conversationId, limit }).messages;

          return ok({
            conversation: withWindow(
              {
                conversationId: conversation.conversationId,
                openKfId: conversation.openKfId,
                externalUserId: conversation.externalUserId,
                name: conversation.name,
                lastMsgAt: conversation.lastMsgAt,
                lastPeerAt: lastPeerAtOf(db, conversationId),
              },
              now(),
            ),
            messages,
            note: args.includeSelf
              ? "已包含本方回复；系统事件不返回。"
              : "只含客户发言。要看本方回复传 includeSelf=true。",
          });
        }

        case "kf_search": {
          const q = String(args.query || "").trim();
          if (!q) return fail("缺少 query", { field: "query" });
          const origins = args.includeSelf ? ["peer", "self"] : ["peer"];
          const messages = searchKfMessages(db, {
            query: q,
            limit: clampLimit(args.limit, 20),
            origins,
          });
          return ok({
            query: q,
            messages,
            note: "检索会命中附件正文；命中在附件里时该条带 matchedIn='attachment'。",
          });
        }

        case "kf_attachment": {
          const messageId = String(args.messageId || "").trim();
          if (!messageId) return fail("缺少 messageId", { field: "messageId" });

          const stored = getKfAttachmentText(db, messageId);
          if (stored) {
            const cap = Math.max(1, Math.min(Number(args.maxChars) || 4000, MCP_LIMITS.attachmentChars));
            const truncated = stored.text.length > cap;
            return ok({
              ok: true,
              messageId,
              kind: stored.kind,
              chars: stored.chars,
              truncated: truncated || stored.truncated,
              text: truncated ? stored.text.slice(0, cap) : stored.text,
            });
          }

          const media = getKfMediaExtractState(db, messageId);
          if (!media) return fail("这条消息没有附件记录", { messageId });
          return ok({
            ok: false,
            messageId,
            state: media.extractState || (media.state === "pending" ? "not_downloaded" : "not_extracted"),
            kind: media.kind,
            reason: media.extractError || null,
          });
        }

        default:
          return fail(`未知工具：${name}`);
      }
    },
  };
}

/** 与 `kfAgentInput` 里同一套挂法：正文随消息带出，没抽出来就说状态。 */
function withAttachment(db, msg) {
  if (!msg.mediaId && !msg.mediaType) return msg;
  const stored = getKfAttachmentText(db, msg.id);
  if (stored) {
    return {
      ...msg,
      attachment: {
        status: "extracted",
        kind: stored.kind,
        chars: stored.chars || stored.text.length,
        truncated: stored.truncated,
        text: stored.text,
      },
    };
  }
  const media = getKfMediaExtractState(db, msg.id);
  return {
    ...msg,
    attachment: {
      status: media?.extractState || "not_extracted",
      kind: media?.kind || null,
      reason: media?.extractError || null,
    },
  };
}

function lastPeerAtOf(db, conversationId) {
  const row = db
    .prepare("SELECT MAX(sent_at) t FROM kf_message WHERE conversation_id=? AND origin='peer'")
    .get(conversationId);
  return Number(row?.t || 0) || null;
}

/** 每个 transport 一个 Server 实例（SDK 不允许复用同一个实例二次 connect）。 */
export function buildServer({ db, now }) {
  const impl = createKfTools({ db, now });
  const server = new Server(
    { name: "kf", version: "1.0.0" },
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
export function openKfDbFromEnv(env = process.env) {
  return createKfDatabase({ file: env.KF_DB || undefined });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openKfDbFromEnv();
  await buildServer({ db }).connect(new StdioServerTransport());
}
