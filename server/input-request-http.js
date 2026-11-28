// ── Input-request over streamable HTTP (add-input-request-cards, design D2) ──
//
// 同一条工具契约的第二种挂载。ACP 系的 harness 只能经 `session/new` 的
// mcpServers 拿 http 服务器（`agent-runner/harness/acp.js`），所以这里把它
// 暴露成一次性 transport 的无状态端点：一次 POST 一个 transport，服务端不
// 持有会话。
//
// 身份不靠 env（HTTP 侧没有 per-user profile），靠两个头 + 一个共享令牌：
//   Authorization: Bearer <INPUT_REQUEST_MCP_TOKEN>
//   x-input-request-owner:   <owner email>
//   x-input-request-session: <session id>
// 三者缺一即拒绝——尤其 owner 为空时宁可不给工具，也不落一行没人能答的记录。

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createInputRequestServer } from "./input-request-mcp.js";
import { secretMatches } from "./auth.js";
import { getDb } from "../db.js";
import { createInputRequest, getInputRequest, waitForInputRequest } from "./input-requests.js";
import { randomUUID } from "node:crypto";

export const INPUT_REQUEST_MCP_PATH = "/api/mcp/input-request/mcp";

/**
 * In-process driver. The HTTP mount runs INSIDE the platform process, so it must
 * not loop back over HTTP (that would target PORT, which is not necessarily this
 * listener, and would double the hops). Same shape as the shim's httpDriver.
 */
export function coreDriver({ ownerEmail, sessionId }) {
  return {
    async create(args) {
      const db = getDb();
      const request = createInputRequest(db, {
        id: `ir_${Date.now()}_${randomUUID().slice(0, 8)}`,
        ownerEmail,
        sessionId: sessionId ?? null,
        card: args?.card,
        policy: args?.policy ?? null,
      });
      return {
        requestId: request.id,
        state: request.state,
        card: request.card,
        expiresAt: request.expiresAt,
        values: null,
        answeredBy: null,
      };
    },
    async wait(requestId) {
      const row = await waitForInputRequest(getDb(), requestId, { timeoutMs: 25_000 });
      if (!row) return null;
      return { requestId: row.id, state: row.state, values: row.values, answeredBy: row.answeredBy };
    },
    async get(requestId) {
      const row = getInputRequest(getDb(), requestId);
      if (!row) throw new Error("input request not found");
      return { requestId: row.id, state: row.state, values: row.values, answeredBy: row.answeredBy };
    },
  };
}

function bearer(req) {
  const raw = req.headers?.authorization;
  if (typeof raw !== "string") return "";
  return raw.replace(/^Bearer\s+/i, "").trim();
}

export function mountInputRequestMcp(app, { token = process.env.INPUT_REQUEST_MCP_TOKEN } = {}) {
  app.post(INPUT_REQUEST_MCP_PATH, async (req, res) => {
    // 没有配置令牌 = 端点不存在。宿主环境显式关闭，比"配了但没校验"安全。
    if (!token) return res.status(404).json({ error: "not_configured" });
    if (!secretMatches(bearer(req), token)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const ownerEmail = String(req.headers["x-input-request-owner"] || "").trim().toLowerCase();
    if (!ownerEmail) return res.status(400).json({ error: "owner_required" });
    const identity = {
      ownerEmail,
      sessionId: String(req.headers["x-input-request-session"] || "").trim() || null,
    };

    const server = await createInputRequestServer({ identity: () => identity, driverFactory: coreDriver });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close());
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[input-request-http] request failed:", err?.message || err);
      if (!res.headersSent) res.status(500).json({ error: "internal error" });
    }
  });
}
