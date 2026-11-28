// ── Trade MCP server (stdio) ─────────────────────────────────────────────────
//
// Exposes the AI-native trade chain to the dsh agent as four tools:
//   trade_discover  → 找店（店目录检索）
//   trade_demand    → 询价（声明要什么，不带价格）
//   trade_quote     → 报价（卖方给有时效的承诺）
//   trade_accept    → 接受报价 → 订单（成交价取自报价，受预算闸约束）
//
// Why a dedicated server instead of the agent calling REST directly:
//   The cell has no general outbound-POST tool — `web_read` is read-only and
//   refuses private addresses, so an agent literally could not reach the ERP
//   trade surface even when it knew the URL. Exposing the four verbs as MCP
//   tools is the difference between "the chain exists" and "the agent can use
//   it" (change establish-ai-native-trade-discovery 5.x).
//
// Delegation credential: the agent does NOT hold a signing key or a registry
// machine credential. It asks THIS bridge for a grant, and the bridge mints one
// server-side from the deployment's registry credential, bounded by
// `ERP_TRADE_GRANT_BUDGET` (the operator's per-call ceiling). `act` is the
// session owner, so the ledger records principal=agent / actor=<owner>.
//
// Failure discipline: every upstream failure comes back as a structured tool
// error and never as a fabricated success. A chain probe that "passes" on an
// invented order is worse than no probe.

import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { fetchWithTimeout } from "../lib/fetch-with-timeout.js";

// stdout carries JSON-RPC; anything else must go to stderr.
console.log = (...args) => console.error(...args);

export function directoryBaseForTest(env) {
  const svcHost = String(env.FD_SHOP_DIRECTORY_SERVICE_HOST || "").trim();
  const svcPort = String(env.FD_SHOP_DIRECTORY_SERVICE_PORT || "80").trim();
  if (svcHost) return `http://${svcHost}:${svcPort}`;
  const raw = String(env.SHOP_DIRECTORY_URL || "").replace(/\/+$/, "");
  if (raw) return raw;
  const host = (env.HOST || "localhost").replace(/^0\.0\.0\.0$/, "127.0.0.1");
  return `http://${host}:${env.PORT || 3000}`;
}
function origin(envKey, fallback) {
  const raw = String(process.env[envKey] || "").replace(/\/+$/, "");
  if (raw) return raw;
  const host = (process.env.HOST || "localhost").replace(/^0\.0\.0\.0$/, "127.0.0.1");
  return `${fallback}${host}:${process.env.PORT || 3000}`;
}

const tradeBase = () => origin("TRADE_API_URL", "http://");

// 目录地址的解析顺序（2026-11-26 实测定型）：
//   1. K8s 注入的 FD_SHOP_DIRECTORY_SERVICE_HOST —— **最可靠**：它由 kubelet 从
//      Service 自身维护，不经过 mcp.json → dsh patch → 子进程 env 这条会过期的链路。
//      实测：配置项在 cell 的 patch 里残留旧值（集群服务名），而 pod 是
//      dnsPolicy: Default（mesh DNS），服务名永远 ENOTFOUND，工具面整片 502。
//   2. 显式配置 SHOP_DIRECTORY_URL（本地 dev / 非 K8s 部署用）。
//   3. 自身 origin（既不是目录也不是 trade —— 只作最后兜底，会诚实失败）。
const directoryBase = () => {
  const svcHost = String(process.env.FD_SHOP_DIRECTORY_SERVICE_HOST || "").trim();
  const svcPort = String(process.env.FD_SHOP_DIRECTORY_SERVICE_PORT || "80").trim();
  if (svcHost) return `http://${svcHost}:${svcPort}`;
  return origin("SHOP_DIRECTORY_URL", "http://");
};

async function callJson(url, { method = "GET", body, headers = {}, timeoutMs = 20_000 } = {}) {
  const res = await fetchWithTimeout(url, {
    method,
    headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }, { timeoutMs });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

// The agent's delegation context is the session owner. The cell passes it in
// as `TRADE_ACTOR` (set by the gateway when it spawns the cell); absent means
// "no delegation" — orders then run without a grant budget, exactly as a human
// placing the order would.
// 谁是委托人：优先 TRADE_ACTOR（部署级覆盖），否则用 cell 自己的用户
// （gateway spawner 按 cell 注入 CELL_USER_EMAIL）。一个人一份 mcp.json，
// 所以不能在 mcp.json 里写死某个邮箱——那样所有用户都会以自己的名义替
// 第一个用户花钱。
export function actorFromEnv(env = process.env) {
  // 逐个 trim 再判空：`TRADE_ACTOR="   "` 在 JS 里是 truthy，直接用 `||` 会
  // 不回落并把委托人变成空串 —— 于是不签票、静默降级为「人下单」。
  // 那种降级没有任何报错，正是最该避免的失败形态。
  const pick = (v) => String(v ?? "").trim();
  return pick(env.TRADE_ACTOR) || pick(env.CELL_USER_EMAIL);
}
function actor() {
  return actorFromEnv();
}

async function mintGrant({ budget, runId }) {
  const owner = actor();
  if (!owner) return { token: null, reason: "no_server_side_actor" };
  const base = origin("TRADE_BRIDGE_URL", "http://");
  const r = await callJson(`${base}/api/trade/grant`, {
    method: "POST",
    body: { run: runId, act: owner, budget },
    timeoutMs: 15_000,
  });
  if (!r.ok || !r.data?.token) {
    // Never fabricate: a missing token downgrades to "human-order" semantics,
    // which the ERP then records as requested_by=merchant (no budget gate).
    return { token: null, reason: r.data?.error || `grant ${r.status}` };
  }
  return { token: r.data.token, exp: r.data.exp };
}

function textOut(text) {
  return { content: [{ type: "text", text }] };
}
function errOut(message) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

const TOOLS = [
  {
    name: "trade_discover",
    description:
      "Find shops that sell what you need. Searches the shop directory by category, keyword or region and returns each " +
      "match WITH its source shop id and public base URL — the directory stores pointers only, so prices always come " +
      "from the shop itself. Distinguishes three outcomes: 'unregistered' (that shop is not in the directory), " +
      "'no_match' (directory reachable, nothing matched) and an explicit unavailable error. Never treat an empty result " +
      "as 'nobody sells this' without checking which of the three you got.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Exact category (e.g. 饮品)." },
        keyword: { type: "string", description: "Substring matched against titles, categories and keywords." },
        region: { type: "string", description: "Optional region filter." },
        tenant: { type: "string", description: "Ask about one specific shop id instead of searching." },
      },
      required: [],
    },
  },
  {
    name: "trade_demand",
    description:
      "Raise a request for quotation. State WHAT you need (lines), WHEN you need it by, and WHERE it ships. You must NOT " +
      "state a price — a buy-side price would turn the quote into a formality and the final price would lose its source; " +
      "the server rejects any price field. Returns a demand_ref the seller quotes against.",
    inputSchema: {
      type: "object",
      properties: {
        tenant: { type: "string", description: "Target shop id (from trade_discover)." },
        lines: {
          type: "array",
          description: "What you need: one entry per product.",
          items: {
            type: "object",
            properties: {
              productId: { type: "string" },
              qty: { type: "number" },
              unit: { type: "string" },
            },
            required: ["productId", "qty"],
          },
        },
        neededBy: { type: "string", description: "ISO date (YYYY-MM-DD) you need delivery by." },
        shipTo: {
          type: "object",
          description: "Delivery contact: name and phone are required.",
          properties: { name: { type: "string" }, phone: { type: "string" }, address: { type: "string" } },
          required: ["name", "phone"],
        },
      },
      required: ["tenant", "lines", "neededBy", "shipTo"],
    },
  },
  {
    name: "trade_quote",
    description:
      "Record the seller's quote against a demand_ref. A quote is a TIME-BOUNDED promise: unit price, currency, a hard " +
      "valid-until, lead time and a minimum order quantity, plus the total quantity you are willing to commit " +
      "(qtyOffered). A quote without an expiry is rejected by design — an open-ended price is not a commitment. Use this " +
      "when you are acting for the seller; when you are the buyer, ask the shop and read its answer.",
    inputSchema: {
      type: "object",
      properties: {
        tenant: { type: "string" },
        demandRef: { type: "string" },
        productId: { type: "string" },
        unitPrice: { type: "string", description: "Decimal string, e.g. \"96.00\"." },
        currency: { type: "string", description: "Defaults to CNY." },
        validUntil: { type: "string", description: "ISO date; MUST be in the future." },
        leadTimeDays: { type: "number" },
        moq: { type: "number", description: "Minimum order quantity." },
        qtyOffered: { type: "number", description: "Total quantity this quote commits to." },
      },
      required: ["tenant", "demandRef", "productId", "unitPrice", "validUntil", "leadTimeDays", "moq", "qtyOffered"],
    },
  },
  {
    name: "trade_accept",
    description:
      "Accept a quote and create the order. The unit price comes from the QUOTE (not the shop's list price) and the " +
      "order records the quote_ref so the price stays explainable after the fact. When a delegation budget is in force " +
      "the order is checked against it and refused if it would exceed it — the amount is always computed server-side, so " +
      "an amount you pass in is ignored. Accepting never moves money: the order lands as awaiting_payment.",
    inputSchema: {
      type: "object",
      properties: {
        tenant: { type: "string" },
        quoteRef: { type: "string" },
        qty: { type: "number" },
        shipTo: {
          type: "object",
          properties: { name: { type: "string" }, phone: { type: "string" }, address: { type: "string" } },
          required: ["name", "phone"],
        },
        channel: { type: "string", description: "Retail channel; defaults to the deployment's configured channel." },
        budget: { type: "string", description: "Optional per-order delegation ceiling (decimal string)." },
      },
      required: ["tenant", "quoteRef", "qty", "shipTo"],
    },
  },
];

function shopUrl(tenant, path) {
  return `${tradeBase()}/shop/${encodeURIComponent(tenant)}/trade${path}`;
}

async function toolDiscover({ category, keyword, region, tenant }) {
  const qs = new URLSearchParams();
  if (category) qs.set("category", category);
  if (keyword) qs.set("q", keyword);
  if (region) qs.set("region", region);
  if (tenant) qs.set("tenant", tenant);
  const r = await callJson(`${directoryBase()}/directory/search?${qs}`, { timeoutMs: 15_000 });
  if (!r.ok) {
    return errOut(
      `shop directory unavailable (${r.status}). That is NOT "nobody sells it" — the directory itself is unreachable; ` +
      `retry, and if it persists the discovery lane is down.`,
    );
  }
  const d = r.data || {};
  if (d.state === "unregistered") {
    return textOut(
      `Shop '${tenant}' is not registered in the directory (state=unregistered). That is different from "it sells ` +
      `nothing": the shop may exist without being discoverable. ${d.note || ""}`.trim(),
    );
  }
  const matches = d.matches || [];
  if (!matches.length) {
    return textOut(
      `No shop matched (state=no_match, searched ${d.searched_shops ?? 0} shops). The directory IS reachable — this is ` +
      `a real "nothing matched", not an outage.`,
    );
  }
  const lines = matches.map(
    (m) => `- ${m.tenant}${m.title ? ` (${m.title})` : ""} · ${m.public_base}${m.categories?.length ? ` · ${m.categories.join("/")}` : ""}`,
  );
  return textOut(`${matches.length} shop(s) matched:\n${lines.join("\n")}`);
}

async function toolDemand({ tenant, lines, neededBy, shipTo }) {
  const r = await callJson(shopUrl(tenant, "/demands"), {
    method: "POST",
    body: { lines, neededBy, shipTo },
    headers: actor() ? { "x-erp-trade-buyer": actor() } : {},
  });
  if (!r.ok) return errOut(explain(r));
  return textOut(
    `Demand raised: ${r.data?.data?.demand_ref} (status ${r.data?.data?.status}). It carries NO price by design — ` +
    `the seller quotes against it.`,
  );
}

async function toolQuote(args) {
  const { tenant, ...body } = args;
  const r = await callJson(shopUrl(tenant, "/quotes"), { method: "POST", body });
  if (!r.ok) return errOut(explain(r));
  const q = r.data?.data || {};
  return textOut(
    `Quote ${q.quote_ref}: ${q.unit_price} ${q.currency} each, valid until ${q.valid_until}, lead ${q.lead_time_days}d, ` +
    `MOQ ${q.moq}, total offered ${q.qty_offered}. It expires — accept before then.`,
  );
}

async function toolAccept({ tenant, quoteRef, qty, shipTo, channel, budget }) {
  const grant = await mintGrant({ budget: budget ?? process.env.ERP_TRADE_GRANT_BUDGET ?? "", runId: `trade-${Date.now()}` });
  const headers = grant.token ? { authorization: `Bearer ${grant.token}` } : {};
  if (actor()) headers["x-erp-trade-buyer"] = actor();
  const body = { qty, shipTo };
  if (channel) body.channel = channel;
  const r = await callJson(shopUrl(tenant, `/quotes/${encodeURIComponent(quoteRef)}/accept`), {
    method: "POST",
    body,
    headers,
  });
  if (!r.ok) return errOut(explain(r));
  const o = r.data?.data || {};
  const gate = grant.token
    ? "under a delegation budget (the order was checked against it)"
    : `WITHOUT a delegation budget (no grant: ${grant.reason}) — this order counts as a human order`;
  return textOut(
    `Order ${o.order_ref} created ${gate}: ${o.amount_total} ${o.currency} at the quoted price ` +
    `(quote ${o.quote_ref}). Payment state: ${o.payment_state} — accepting never moves money.`,
  );
}

// Turn an upstream error shell into a sentence the model can act on. The ERP's
// closed error catalogue is the source of truth; we never invent a code.
export function explainForTest(r) { return explain(r); }
function explain(r) {
  const e = r.data?.error;
  // 兜底：上游返回了 error 壳但字段缺失时，旧实现会拼出 "undefined: undefined"
  // ——那对排查毫无价值，还会让人以为是工具坏了而不是上游拒了。
  if (!e || (!e.code && !e.message)) {
    return `upstream ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`;
  }
  const detail = e.detail && Object.keys(e.detail).length ? ` (${JSON.stringify(e.detail)})` : "";
  return `${e.code || "UPSTREAM"}: ${e.message || "(no message)"}${detail}${e.hint ? ` — ${e.hint}` : ""}`;
}

const server = new Server({ name: "trade", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    switch (name) {
      case "trade_discover":
        return await toolDiscover(args);
      case "trade_demand":
        return await toolDemand(args);
      case "trade_quote":
        return await toolQuote(args);
      case "trade_accept":
        return await toolAccept(args);
      default:
        return errOut(`unknown tool: ${name}`);
    }
  } catch (err) {
    return errOut(`${name} failed: ${err?.message || err}`);
  }
});

// Start the stdio transport only when this module IS the process entrypoint.
// Connecting on import is a trap: `server/trade-mcp.test.js` imports this file
// for its pure helpers, and in CI stdin is a pipe that never closes — the test
// ran every case green and then never exited (shard SIGKILL at the 180s budget,
// 2026-11-28; locally stdin is /dev/null so the same file exits in 0.3s).
// TRADE_MCP_NO_CONNECT=1 stays as the explicit escape hatch.
const isEntrypoint =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint && process.env.TRADE_MCP_NO_CONNECT !== "1") {
  await server.connect(new StdioServerTransport());
}
