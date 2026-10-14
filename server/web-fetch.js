// ── Shared web fetch + HTML-to-text (leaf module) ────────────────────────────
//
// Single source of truth for outbound page fetching so the SSRF guard, proxy
// handling, and extraction can never drift between consumers. Users today:
// documents.js (URL ingestion for RAG) and websearch-mcp.js (web_read tool).
// Dependency-free on purpose — imported by both the server process and the
// websearch stdio MCP child.

export const MAX_FETCH_BYTES = 2_000_000;
export const FETCH_TIMEOUT_MS = 15_000;

// Resolve the HTTP(S) proxy to use for outbound fetches. Node's global fetch
// does not honor http_proxy/https_proxy env vars, so this is consumed
// explicitly below. https_proxy is preferred over http_proxy.
export function proxyForUrl() {
  return (
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY ||
    ""
  );
}

// Block loopback, private, link-local, and .local hosts to prevent SSRF.
export function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;

  const parts = host.split(".").map(Number);
  if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local
  }
  return false;
}

// Strip scripts/styles then tags to plain text.
export function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

// Fetch an http(s) URL and return its readable text. Refuses non-http(s)
// schemes and private/local hosts (SSRF), follows redirects, honors the
// proxy env vars, and is bounded by timeout + byte cap.
export async function fetchUrlAsText(url, { timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_FETCH_BYTES } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http(s) URLs are allowed");
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error("Fetching private or local network hosts is not allowed");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const proxyUrl = proxyForUrl();
  let res;
  try {
    const options = {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "platform-documents/1.0" },
    };
    if (proxyUrl) {
      // Node's global fetch ignores http_proxy/https_proxy env vars, so when a
      // proxy is configured route through it via undici's ProxyAgent dispatcher
      // (undici is the engine behind Node's fetch). undici's own fetch is used
      // here so the dispatcher instance is guaranteed compatible.
      const { ProxyAgent, fetch: undiciFetch } = await import("undici");
      options.dispatcher = new ProxyAgent(proxyUrl);
      res = await undiciFetch(url, options);
    } else {
      res = await fetch(url, options);
    }
  } catch (err) {
    throw new Error(`URL fetch failed: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new Error(`URL fetch failed: HTTP ${res.status}`);

  let html = await res.text();
  if (html.length > maxBytes) html = html.slice(0, maxBytes);
  return htmlToText(html);
}
