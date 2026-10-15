import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import http from "node:http";
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import { tempStoreDirs } from "./helpers.js";

// Web search capability (spec: web-search). Two halves, same split as
// cron-tools/library-tools — the fast suite is no-LLM by design:
//   1. The MCP child contract, driven directly over stdio JSON-RPC against an
//      in-spec stub relay (mounting/dsh plumbing is the mcp-integration spec's
//      job; here we prove the tools' observable behavior).
//   2. Boot-level wiring against the webServer: the bundled websearch server
//      is seeded (origin "bundled", enabled) and lands in the generated dsh
//      mcp patch; the admin disable/enable round-trip regenerates the patch.

const ROOT = path.resolve(import.meta.dirname, "..");

// ── Stub relay (loopback is fine: the relay client has no SSRF guard) ────────
function startRelay() {
  const hits = [];
  let mode = "ok";
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ auth: req.headers.authorization, body: JSON.parse(body) });
      if (mode === "500") {
        res.writeHead(500, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "upstream exhausted" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        results: [
          { title: "Stub One", url: "https://stub.example/1", snippet: "first" },
          { title: "Stub Two", url: "https://stub.example/2", snippet: "second" },
        ],
      }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, hits, getPort: () => server.address().port, setMode: (m) => (mode = m) })),
  );
}

// ── Stub page server for web_read (dual-stack so localtest.me works) ────────
function startPages() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/big")) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<p>${"word ".repeat(120000)}</p>`);
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body><h1>Page</h1><script>bad()</script><p>Readable &amp; stub text</p></body></html>");
  });
  return new Promise((resolve) =>
    server.listen(0, "::", () => resolve({ server, getPort: () => server.address().port })),
  );
}

// ── Minimal stdio JSON-RPC driver (pattern: e2e/library-tools.spec.js) ──────
class McpChild {
  static async start(env) {
    const child = spawn("node", ["server/websearch-mcp.js"], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const mcp = new McpChild(child);
    child.stdout.on("data", mcp.#onData);
    child.stderr.on("data", () => {});
    const init = await mcp.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "e2e-probe", version: "0" },
    });
    expect(init.serverInfo.name).toBe("websearch");
    await mcp.notify("notifications/initialized", {});
    return mcp;
  }

  #child;
  #buf = "";
  #pending = new Map();
  #nextId = 1;

  constructor(child) {
    this.#child = child;
  }

  #onData = (chunk) => {
    this.#buf += chunk.toString();
    for (;;) {
      const nl = this.#buf.indexOf("\n");
      if (nl < 0) break;
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id != null && this.#pending.has(msg.id)) {
        this.#pending.get(msg.id)(msg);
        this.#pending.delete(msg.id);
      }
    }
  };

  call(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      this.#pending.set(id, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)));
      this.#child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method, params) {
    this.#child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  kill() {
    this.#child.kill();
  }
}

const tool = (m, name, args) => m.call("tools/call", { name, arguments: args });
const textOf = (r) => r.content[0].text;

test.describe("websearch MCP tools (contract)", () => {
  let relay;
  let pages;
  let m;
  let localtestOk = false;

  test.beforeAll(async () => {
    relay = await startRelay();
    pages = await startPages();
    try { localtestOk = ["127.0.0.1", "::1"].includes((await dns.lookup("localtest.me")).address); } catch { localtestOk = false; }
    m = await McpChild.start({
      SEARCH_RELAY_URL: `http://127.0.0.1:${relay.getPort()}`,
      SEARCH_RELAY_TOKEN: "e2e-relay-token",
    });
  });

  test.afterAll(() => {
    m?.kill();
    relay?.server.close();
    pages?.server.close();
  });

  test("lists both tools", async () => {
    const { tools } = await m.call("tools/list", {});
    expect(tools.map((t) => t.name)).toEqual(["web_search", "web_read"]);
  });

  test("web_search returns normalized results with auth and clamped num", async () => {
    const r = await tool(m, "web_search", { query: "  hello  ", num: 99 });
    const parsed = JSON.parse(textOf(r));
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[0]).toMatchObject({ title: "Stub One", url: "https://stub.example/1", snippet: "first" });
    expect(relay.hits.at(-1).auth).toBe("Bearer e2e-relay-token");
    expect(relay.hits.at(-1).body).toEqual({ query: "hello", num: 10 });
  });

  test("invalid arguments never reach the relay", async () => {
    const before = relay.hits.length;
    const empty = await tool(m, "web_search", { query: "   " });
    expect(empty.isError).toBe(true);
    const badNum = await tool(m, "web_search", { query: "x", num: "8" });
    expect(badNum.isError).toBe(true);
    expect(relay.hits.length).toBe(before);
  });

  test("relay error surfaces explicitly", async () => {
    relay.setMode("500");
    const r = await tool(m, "web_search", { query: "boom" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("HTTP 500");
    relay.setMode("ok");
  });

  test("web_read refuses non-http schemes and private hosts", async () => {
    const ftp = await tool(m, "web_read", { url: "ftp://example.com/x" });
    expect(ftp.isError).toBe(true);
    expect(textOf(ftp)).toContain("Only http(s)");
    // The page server IS listening on loopback — refusal proves the SSRF
    // guard runs before any fetch.
    const loop = await tool(m, "web_read", { url: `http://127.0.0.1:${pages.getPort()}/` });
    expect(loop.isError).toBe(true);
    expect(textOf(loop)).toContain("private or local network");
  });

  test("web_read extracts readable text and truncates oversized pages", async () => {
    test.skip(!localtestOk, "localtest.me wildcard DNS unavailable in this environment");
    const r = await tool(m, "web_read", { url: `http://localtest.me:${pages.getPort()}/` });
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toContain("Readable & stub text");
    expect(textOf(r)).not.toContain("<p>");
    const big = await tool(m, "web_read", { url: `http://localtest.me:${pages.getPort()}/big` });
    expect(textOf(big)).toContain("[truncated at 50000 characters]");
  });

  test("unconfigured relay degrades explicitly; web_read unaffected", async () => {
    const m2 = await McpChild.start({});
    const r = await tool(m2, "web_search", { query: "anything" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("not configured");
    m2.kill();
    // The configured child's web_read still works — no relay involvement.
    if (localtestOk) {
      const read = await tool(m, "web_read", { url: `http://localtest.me:${pages.getPort()}/` });
      expect(read.isError).toBeUndefined();
    }
  });
});

test.describe("websearch bundled wiring (boot-level)", () => {
  const stores = tempStoreDirs();

  function patchPath() {
    return path.join(stores.dshHome, "profiles", process.env.DSH_PROFILE || "platform", "mcp.patch.yml");
  }

  test("bundled server is seeded and mounted at boot", async ({ page }) => {
    // The webServer booted server.js with a fresh store tree; the bundle
    // entry must have become a DB row and a dsh patch entry.
    const res = await page.request.get("/api/extensions/mcp");
    expect(res.ok()).toBe(true);
    const { servers } = await res.json();
    const row = servers.find((s) => s.name === "websearch");
    expect(row).toMatchObject({ origin: "bundled", enabled: true });

    const patch = fs.readFileSync(patchPath(), "utf8");
    expect(patch).toContain("serverName: websearch");
    // envRefs forwarding: the relay pair must ride the patch entry's explicit
    // env (dsh's subprocess scrub strips TOKEN-shaped ambient names), not the
    // inherited environment.
    expect(patch).toContain("SEARCH_RELAY_URL");
    expect(patch).toContain("SEARCH_RELAY_TOKEN");
  });

  test("admin disable/enable round-trips the patch", async ({ page }) => {
    const off = await page.request.put("/api/extensions/mcp/websearch", { data: { enabled: false } });
    expect(off.ok()).toBe(true);
    // dshUpdateMcp is fire-and-forget; poll for the HMR patch rewrite.
    await expect
      .poll(async () => !fs.readFileSync(patchPath(), "utf8").includes("serverName: websearch"), { timeout: 20_000 })
      .toBe(true);

    const on = await page.request.put("/api/extensions/mcp/websearch", { data: { enabled: true } });
    expect(on.ok()).toBe(true);
    await expect
      .poll(async () => fs.readFileSync(patchPath(), "utf8").includes("serverName: websearch"), { timeout: 20_000 })
      .toBe(true);
  });
});
