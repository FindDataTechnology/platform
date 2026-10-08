// ── Websearch MCP server (stdio) ─────────────────────────────────────────────
//
// Exposes web retrieval to the dsh agent as two MCP tools — web_search and
// web_read — declared in platform.bundle.json (origin "bundled") and mounted
// through dsh-mcp-client as mcp__websearch__<tool>, available to every persona
// preset and every deployment form with zero customer configuration.
//
// web_search is a thin client for the operator-run search relay: the key pool
// (multiple SerpAPI keys with rotation), the GLM fallback, caching, and
// per-token rate caps all live relay-side. This process holds exactly one
// endpoint URL and one relay token, inherited from the platform server's
// environment (SEARCH_RELAY_URL / SEARCH_RELAY_TOKEN). Unset or unreachable
// relay degrades to an explicit tool error — never a hang, never a crash.
//
// web_read fetches a page and extracts readable text LOCALLY (shared
// server/web-fetch.js: scheme allowlist, SSRF guard, proxy support, bounded
// fetch) — no relay involvement, so it keeps working when the relay is down.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { fetchUrlAsText } from "./web-fetch.js";

// The stdio channel IS the protocol: stdout must carry JSON-RPC and nothing
// else.
console.log = (...args) => console.error(...args);

const SEARCH_TIMEOUT_MS = 15_000;
const DEFAULT_NUM = 8;
const MAX_NUM = 10;
const MAX_READ_CHARS = 50_000;

function relayConfig() {
  const url = process.env.SEARCH_RELAY_URL?.trim();
  const token = process.env.SEARCH_RELAY_TOKEN?.trim();
  if (!url || !token) return null;
  return { base: url.replace(/\/$/, ""), token };
}

const TOOLS = [
  {
    name: "web_search",
    description:
      "Search the web for current, real-time information (news, facts, prices, releases — anything beyond your training data " +
      "or the local document library). Returns a normalized list of results (title, url, snippet); engine-agnostic — you never " +
      "choose an engine. Follow up with web_read on a result url when snippets are not enough to answer.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query, in the language most likely to match good sources." },
        num: { type: "number", description: "Number of results to return (1-10). Defaults to 8." },
      },
      required: ["query"],
    },
  },
  {
    name: "web_read",
    description:
      "Fetch a web page by its http(s) URL and return its readable text (not raw HTML). Use it to read a web_search result " +
      "in full, or any public page the user names. Very long pages are truncated; private/local-network addresses are refused.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL of the page to read." },
      },
      required: ["url"],
    },
  },
];

function textOut(text) {
  return { content: [{ type: "text", text }] };
}
function errOut(message) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

async function toolWebSearch({ query, num }) {
  if (typeof query !== "string" || !query.trim()) return errOut("`query` must be a non-empty string");
  let count = num === undefined ? DEFAULT_NUM : num;
  if (typeof count !== "number" || !Number.isFinite(count)) return errOut("`num` must be a number");
  count = Math.min(MAX_NUM, Math.max(1, Math.floor(count)));

  const relay = relayConfig();
  if (!relay) {
    return errOut(
      "Web search is not configured on this deployment (SEARCH_RELAY_URL / SEARCH_RELAY_TOKEN missing). " +
        "Tell the user search is unavailable here; other tools still work.",
    );
  }

  let res;
  try {
    res = await fetch(`${relay.base}/v1/search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${relay.token}`,
      },
      body: JSON.stringify({ query: query.trim(), num: count }),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
  } catch (err) {
    const why = err?.name === "TimeoutError" ? `no response within ${SEARCH_TIMEOUT_MS / 1000}s` : err?.message || "network error";
    return errOut(`Search relay unreachable (${why}). Web search is temporarily unavailable.`);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      return errOut("Search relay rejected the deployment's credentials (not configured or unauthorized).");
    }
    return errOut(`Search relay: HTTP ${res.status}${data.error ? ` — ${data.error}` : ""}`);
  }
  if (!Array.isArray(data.results)) {
    return errOut("Search relay returned a malformed response (no results list).");
  }
  const results = data.results
    .filter((r) => r && typeof r.url === "string")
    .map((r) => ({ title: String(r.title ?? ""), url: r.url, snippet: String(r.snippet ?? "") }));
  if (!results.length) return textOut(JSON.stringify({ results: [], note: "No results for this query." }));
  return textOut(JSON.stringify({ results }));
}

async function toolWebRead({ url }) {
  if (typeof url !== "string" || !url.trim()) return errOut("`url` must be a non-empty string");
  let text;
  try {
    text = await fetchUrlAsText(url.trim());
  } catch (err) {
    return errOut(err.message || "URL fetch failed");
  }
  if (text.length > MAX_READ_CHARS) {
    text = `${text.slice(0, MAX_READ_CHARS)}\n\n[truncated at ${MAX_READ_CHARS} characters]`;
  }
  if (!text) return errOut("The page returned no extractable text.");
  return textOut(text);
}

const server = new Server({ name: "websearch", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params ?? {};
  try {
    switch (name) {
      case "web_search": return await toolWebSearch(args);
      case "web_read": return await toolWebRead(args);
      default: return errOut(`unknown tool: ${name}`);
    }
  } catch (err) {
    return errOut(err.message || "tool failed");
  }
});

await server.connect(new StdioServerTransport());
