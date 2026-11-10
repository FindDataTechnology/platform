// ── Per-cell MCP satellite host (share-mcp-satellites-per-cell) ─────────────
//
// Every dsh runtime used to spawn its own copy of the cell's MCP satellites
// (13 child processes, 65–77Mi each). With `TASK_WORKER_MAX>0` a cell runs a
// main bridge PLUS one runtime per worker slot, so the whole set existed two,
// three, N times over for the SAME cell — same credentials, same data root,
// same owner. Measured: ≈930Mi nominal / ≈450Mi calibrated per dsh; the
// duplicate is what pushed fd-prod to 2845Mi of a 4096Mi pod and made the
// memory gate refuse the next cell's wake.
//
// This host owns ONE copy per cell and re-exposes each satellite as its own
// streamable-http endpoint (`/<name>/mcp`), because dsh composes one MCP client
// entry per server name — merging them into a single endpoint would collapse
// distinct server identities and collide tool names.
//
// Scope (design.md F2): only satellites whose startup env is cell-level are
// shareable. Member-scoped ones (library collections, websearch user key,
// fd-memory member token) and session-scoped `actions` (DSH_SESSION_ID) MUST
// stay per-runtime — pairing them through here would show one member's view to
// another.
//
// Stateless on purpose: one transport per HTTP request (the library-mcp
// precedent). Tools/list and tools/call are request/response; forwarding the
// satellites' own progress notifications is deliberately out of scope for v1
// and noted as a follow-up rather than silently dropped mid-stream.

import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";

const SERVICE_VERSION = "1.0.0";

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

// `satellites`: [{ name, command, args, env, cwd }] — the same shape the
// composed mcp patch carries, so the host never re-derives composition.
export function createMcpSatelliteHost({ satellites = [], host = "127.0.0.1", port = 0, logger = console } = {}) {
  const clients = new Map(); // name -> Client
  const specs = new Map(); // name -> spec
  const startedAt = Date.now();
  let httpServer = null;
  let boundPort = null;
  let stopping = false;
  let calls = 0;

  async function startSatellite(spec) {
    // Register the spec BEFORE connecting: a satellite that fails to start must
    // be reported as down, not silently absent from the health face (a missing
    // entry reads like "we never intended to serve it").
    specs.set(spec.name, spec);
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args ?? [],
      env: spec.env ?? process.env,
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      stderr: "inherit",
    });
    const client = new Client({ name: `satellite-host:${spec.name}`, version: SERVICE_VERSION }, { capabilities: {} });
    // A satellite that dies AFTER startup must leave the registry, or health
    // keeps claiming `up:true` for a corpse and every call surfaces the SDK's
    // generic "Not connected" instead of our own reason. (Found while writing
    // the failure-domain test: the process was SIGKILLed and health still lied.)
    const onGone = (why) => {
      if (clients.get(spec.name) !== client) return;
      clients.delete(spec.name);
      logger.warn(`[satellite-host] ${spec.name} went away (${why}); its endpoint now reports not running`);
    };
    client.onclose = () => onGone("client closed");
    transport.onclose = () => onGone("transport closed");
    await client.connect(transport);
    clients.set(spec.name, client);
    return client;
  }

  // One local MCP server per request, whose handlers forward to the named
  // satellite. Stateless: nothing survives the response, so a satellite restart
  // needs no session bookkeeping (the caller's next request re-lists tools).
  function buildEndpoint(name) {
    const server = new Server({ name, version: SERVICE_VERSION }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const client = clients.get(name);
      if (!client) throw new McpError(ErrorCode.InternalError, `satellite "${name}" is not running`);
      return client.listTools();
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const client = clients.get(name);
      if (!client) throw new McpError(ErrorCode.InternalError, `satellite "${name}" is not running`);
      calls += 1;
      try {
        return await client.callTool(
          { name: request.params.name, arguments: request.params.arguments },
          undefined,
          { signal: extra.signal, timeout: 600000, resetTimeoutOnProgress: true },
        );
      } catch (err) {
        if (err instanceof McpError) throw err;
        throw new McpError(ErrorCode.InternalError, err?.message || String(err));
      }
    });
    return server;
  }

  async function handle(req, res) {
    const url = new URL(req.url || "/", `http://${host}:${boundPort ?? port}`);
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: [...clients.keys()].length === [...specs.keys()].length && specs.size > 0,
          uptimeMs: Date.now() - startedAt,
          calls,
          satellites: [...specs.keys()].map((n) => ({ name: n, up: clients.has(n) })),
        }),
      );
      return;
    }
    const m = url.pathname.match(/^\/([A-Za-z0-9._-]+)\/mcp$/);
    // Route on the DECLARED set, not the live one: a satellite that died must
    // answer "not running" (something the caller can act on), not "unknown
    // endpoint" (which reads as a configuration mistake). Only a name we never
    // declared is a 404.
    if (!m || !specs.has(m[1])) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "unknown satellite endpoint" }));
      return;
    }
    const name = m[1];
    if (!clients.has(name)) {
      const reason = `satellite "${name}" is not running`;
      if (req.method === "POST") {
        // Mirror the transport's own failure shape (200 + JSON-RPC error in an
        // SSE frame) so callers see one consistent contract either way.
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: reason } })}\n\n`);
        return;
      }
      res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: reason }));
      return;
    }
    let body;
    if (req.method === "POST") {
      try {
        body = await readJsonBody(req);
      } catch {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid json" }));
        return;
      }
    }
    const server = buildEndpoint(name);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      logger.error(`[satellite-host] ${name} request failed: ${err?.message || err}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null }));
      }
    }
  }

  return {
    get port() {
      return boundPort ?? port;
    },
    get names() {
      return [...specs.keys()];
    },
    health() {
      return {
        ok: specs.size > 0 && [...specs.keys()].every((n) => clients.has(n)),
        satellites: [...specs.keys()].map((n) => ({ name: n, up: clients.has(n) })),
        calls,
      };
    },
    async start() {
      stopping = false;
      for (const spec of satellites) {
        try {
          await startSatellite(spec);
        } catch (err) {
          // Fail-open per satellite: one broken server must not take the rest of
          // the cell's tools down, and the caller keeps its stdio fallback.
          logger.error(`[satellite-host] ${spec.name} failed to start: ${err?.message || err}`);
        }
      }
      httpServer = createServer((req, res) => void handle(req, res));
      await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          boundPort = httpServer.address().port;
          resolve();
        });
      });
      logger.log(
        `[satellite-host] ${[...clients.keys()].join(",") || "(none)"} on ${host}:${boundPort} ` +
          `(one copy per cell; dsh generations attach by url)`,
      );
      return this;
    },
    async stop() {
      stopping = true;
      for (const [name, client] of [...clients.entries()]) {
        try {
          await client.close();
        } catch (err) {
          logger.warn(`[satellite-host] ${name} close failed: ${err?.message || err}`);
        }
        clients.delete(name);
      }
      if (httpServer) {
        const h = httpServer;
        httpServer = null;
        await new Promise((r) => {
          h.close(r);
          h.closeAllConnections?.();
        });
      }
      void stopping;
    },
  };
}
