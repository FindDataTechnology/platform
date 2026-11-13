// ── fd-health-config MCP shim ────────────────────────────────────────────────
// Thin, read-only MCP server (Streamable HTTP, stateless) over finddata's
// central library table fd_open_data.public.health_config — the 總闸/限流
// config the spider-heal inspector reads (config priority: file > this table >
// defaults). One tool: health_config_get. The caller is the 萬星 agent via the
// registry proxy (mcp.finddatatech.cloud/<name>/mcp); auth is the upstream
// trust boundary — nothing sensitive ever leaves except the config values.
//
// Env: FD_HEALTH_DSN (postgres:// read-only account), PORT (default 8090).
import http from "node:http";
import pg from "pg";

const PORT = Number(process.env.PORT || 8090);
const DSN = process.env.FD_HEALTH_DSN || "";
if (!DSN) {
  console.error("[fd-health-mcp] FD_HEALTH_DSN is required");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: DSN, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 8000 });

const TOOLS = [
  {
    name: "health_config_get",
    description:
      "读取 finddata 中央库健康巡检配置（fd_open_data.public.health_config 全量键值）：master_switch（总闸，false=纯巡检不出修复单）、max_daily_tickets（每日工单上限）、lookback_hours、thresholds、excluded_sources、expected_period_overrides；updated_at 为最近变更时间。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

async function healthConfigGet() {
  const r = await pool.query(
    "SELECT key, value, updated_at FROM public.health_config ORDER BY key",
  );
  const rows = r.rows.map((x) => ({ key: x.key, value: x.value, updated_at: x.updated_at }));
  const updatedAt = rows.reduce((m, x) => {
    const t = x.updated_at ? new Date(x.updated_at).toISOString() : null;
    return t && (!m || t > m) ? t : m;
  }, null);
  return { source: "fd_open_data.public.health_config", updated_at: updatedAt, config: Object.fromEntries(rows.map((x) => [x.key, x.value])), rows };
}

const log = (...a) => console.log(`[fd-health-mcp] ${new Date().toISOString()}`, ...a);

function jsonrpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function jsonrpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleOne(msg) {
  const { id, method, params } = msg ?? {};
  if (method === "initialize") {
    return jsonrpcResult(id, {
      protocolVersion: params?.protocolVersion || "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "fd-health-config", version: "1.0.0" },
    });
  }
  if (method === "tools/list") return jsonrpcResult(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params?.name;
    if (name !== "health_config_get") return jsonrpcError(id, -32602, `unknown tool: ${name}`);
    const out = await healthConfigGet();
    return jsonrpcResult(id, { content: [{ type: "text", text: JSON.stringify(out, null, 1) }] });
  }
  if (method === "ping") return jsonrpcResult(id, {});
  // notifications (initialized/cancelled/...) carry no id
  if (id === undefined || id === null) return null;
  return jsonrpcError(id, -32601, `method not found: ${method}`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/healthz") {
    try {
      await pool.query("SELECT 1");
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, db: "up" }));
    } catch (e) {
      res.writeHead(503, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, db: String(e.message) }));
    }
  }
  if (url.pathname !== "/mcp" && !url.pathname.endsWith("/mcp")) {
    res.writeHead(404).end();
    return;
  }
  if (req.method === "GET" || req.method === "DELETE") {
    // Stateless server: no SSE stream, no sessions.
    res.writeHead(405, { Allow: "POST" }).end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" }).end();
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = null;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(jsonrpcError(null, -32700, "parse error")));
  }
  try {
    const batch = Array.isArray(body);
    const msgs = batch ? body : [body];
    log(msgs.map((m) => (m?.method === "tools/call" ? `tools/call:${m?.params?.name}` : m?.method)).join(","));
    const out = [];
    for (const m of msgs) {
      const r = await handleOne(m);
      if (r) out.push(r);
    }
    if (out.length === 0) {
      res.writeHead(202).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(batch ? out : out[0]));
  } catch (e) {
    log("error:", e.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(jsonrpcError(body?.id ?? null, -32603, `internal error: ${e.message}`)));
  }
});

server.listen(PORT, () => log(`listening on :${PORT} (db via FD_HEALTH_DSN)`));