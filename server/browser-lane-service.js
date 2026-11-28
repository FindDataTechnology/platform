// ── Pod-level shared browser service (slim-browser-lane-footprint) ──────────
//
// One @playwright/mcp + one chromium per POD, many cells per process. The lane
// used to cost every cell a stdio shim (~50MB) plus a @playwright/mcp child
// (~120MB) with no chromium running at all — 4 idle cells ≈ 640MB of a 4Gi pod.
// This process is the pod's single copy.
//
// Why a protocol frontend exists at all (design D2): dsh's MCP client speaks
// `stdio` and `streamable-http` only, while @playwright/mcp's `--port` serves
// SSE. Nothing in either version tree bridges them, so this service accepts
// streamable-http sessions from cells and opens ONE SSE client session to the
// local playwright MCP per cell session. That 1:1 session mapping is also what
// gives each cell its own browser context: playwright MCP's --port mode creates
// a separate context per HTTP session, and we deliberately never pass
// --shared-browser-context (D3, and the 1.2 sentinel test).
//
// Three responsibilities, in this order of importance:
//   1. Serve the pod's single playwright MCP (spawn + supervise + restart).
//   2. Bridge each cell session onto its own upstream session, forwarding
//      tools/list, tools/call, progress, cancellation and error codes.
//   3. Point that session's artifacts at the calling cell's workspace
//      (lib/browser-lane-artifacts.js) using an identity resolved from the
//      connection's peer process (lib/browser-lane-identity.js) — never from
//      anything the caller writes.
//
// Failure posture (D6): if the shared service or its upstream is down, the cell
// degrades through dsh's ordinary MCP failure path. This process NEVER spawns a
// per-cell playwright — that would silently recreate the shape being removed.
//
// Env (see .env.example → "Shared browser lane"):
//   BROWSER_SHARED_PORT           listen port for cells (default 9310)
//   BROWSER_SHARED_HOST           bind host (default 127.0.0.1; loopback only)
//   BROWSER_SHARED_UPSTREAM_PORT  playwright MCP --port (default 9311)
//   BROWSER_SHARED_UPSTREAM_URL   attach to an EXISTING SSE endpoint instead of
//                                 spawning (used by tests and by operators who
//                                 run the CLI themselves)
//   BROWSER_SHARED_OUTPUT_ROOT    the CLI's shared --output-dir
//   BROWSER_SHARED_CALL_TIMEOUT_MS  per-call ceiling (default 600000)
//   BROWSER_MCP_CLI / BROWSER_CHROMIUM_PATH / PLAYWRIGHT_BROWSERS_PATH /
//   BROWSER_HEADLESS / BROWSER_SANDBOX / BROWSER_CDP_ENDPOINT  as the shim
//   CELL_DATA_ROOT                the deployment's cell data root (identity)

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import {
  adoptNewFiles,
  artifactDirForCell,
  ensureDir,
  listArtifactNames,
  rewriteArtifactArgs,
} from "../lib/browser-lane-artifacts.js";
import { resolvePeerCell } from "../lib/browser-lane-identity.js";
import { resolveBrowserLaunchConfig } from "../lib/browser-runtime.js";
import { defaultCellsRoot } from "../lib/proc-memory.js";

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

// A listening socket is the only readiness signal that costs nothing: probing
// /sse would open a session of its own, and an SSE session is a browser
// context's worth of state.
function probeListening({ host, port, timeoutMs = 500 }) {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function waitForListening({ host, port, timeoutMs, isAborted }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isAborted?.()) return false;
    if (await probeListening({ host, port })) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// The upstream CLI's argv. --shared-browser-context is NEVER passed: per-session
// contexts are the isolation boundary (D3). --isolated keeps the profile in
// memory so a shared pod-level browser cannot leave a cell's cookies on disk
// where another cell could open them.
// --host 127.0.0.1 is NOT optional: the CLI's default is `localhost`, which on
// a dual-stack host can bind ::1 only — the frontend (and its readiness probe)
// then gets ECONNREFUSED on 127.0.0.1 even though the CLI is "listening"
// (caught by the local smoke run, 2026-11-08). Pinning the literal loopback
// address also keeps the lane unreachable from outside the pod's netns.
// --allowed-hosts must carry the PORT: the CLI's own guard compares the
// request's Host header against this list, and its default entry is
// `localhost:<port>`. Binding 127.0.0.1 without an allowed-host entry of
// `127.0.0.1:<port>` yields a hard 403 ("Access is only allowed at …") for the
// frontend's own SSE connection — found by the local smoke run, 2026-11-08.
// The entry stays exact rather than '*' so the guard keeps its teeth.
export function upstreamArgs({ configPath, port, outputRoot, host = "127.0.0.1" }) {
  const args = [
    "--config",
    configPath,
    "--host",
    host,
    "--allowed-hosts",
    `${host}:${port}`,
    "--port",
    String(port),
    "--isolated",
    // The pin sandboxes file writes to its "workspace roots" (cwd by default).
    // This service has no single workspace — it writes into whichever CELL the
    // call belongs to, and the lane must also READ files the agent uploads from
    // that cell. Per-cell cwds are exactly the shape being removed, so the
    // sandbox is opened here deliberately; the frontend still forces every
    // output filename down to a basename inside the caller's artifact dir, so a
    // model cannot use these args to walk the filesystem
    // (caught by scripts/smoke-browser-lane-shared.mjs, 2026-11-08).
    "--allow-unrestricted-file-access",
  ];
  if (outputRoot) args.push("--output-dir", outputRoot);
  return args;
}

export function createBrowserLaneService({
  env = process.env,
  identifyCell = null,
  cellsRoot = defaultCellsRoot(),
  logger = console,
} = {}) {
  const host = (env.BROWSER_SHARED_HOST || "127.0.0.1").trim();
  const port = Number(env.BROWSER_SHARED_PORT || 9310);
  const upstreamPort = Number(env.BROWSER_SHARED_UPSTREAM_PORT || 9311);
  const attachUrl = (env.BROWSER_SHARED_UPSTREAM_URL || "").trim();
  // Identity is resolved from the connection's peer process by default; tests
  // (and any future transport that can name its peer) inject the resolver.
  const resolveIdentity = identifyCell ?? ((socket) => resolvePeerCell({ socket, cellsRoot }));
  const callTimeoutMs = Number(env.BROWSER_SHARED_CALL_TIMEOUT_MS || 600000);
  // Session retirement. The MCP client dsh ships DEFINES `terminateSession()`
  // (which sends DELETE) but never calls it — its teardown closes the transport,
  // which only aborts locally. Without a reaper every cell restart would leave a
  // session (and its browser context) alive in this service forever: a shared
  // pod would leak one context per boot. Idle > threshold is the honest proxy
  // for "this caller is gone" (an actively used session touches us constantly).
  const sessionIdleMs = Number(env.BROWSER_SHARED_SESSION_IDLE_MS ?? 1800000); // 30 min; 0 disables
  const sessionSweepMs = Number(env.BROWSER_SHARED_SESSION_SWEEP_MS || 60000);
  const outputRoot =
    (env.BROWSER_SHARED_OUTPUT_ROOT || "").trim() ||
    join((env.AGENT_WORKSPACE || tmpdir()).trim() || tmpdir(), "browser-lane");

  const sessions = new Map();
  const state = {
    startedAt: null,
    upstream: {
      mode: attachUrl ? "attach" : "spawn",
      pid: null,
      restarts: 0,
      lastExit: null,
      lastError: null,
      reachable: false,
      url: null,
    },
    calls: 0,
  };

  let httpServer = null;
  let upstreamProc = null;
  let upstreamConfigDir = null;
  let stopping = false;
  let restartTimer = null;
  let sweepTimer = null;

  const upstreamBase = attachUrl || `http://127.0.0.1:${upstreamPort}`;
  state.upstream.url = upstreamBase;
  const sseUrl = `${upstreamBase.replace(/\/$/, "")}/sse`;

  // ── upstream supervision (1.2) ───────────────────────────────────────────
  function spawnUpstream() {
    const { cli, config, error } = resolveBrowserLaunchConfig({ env, outputDir: outputRoot });
    if (error) {
      state.upstream.lastError = error;
      logger.error(`[browser-lane] cannot start the shared playwright MCP: ${error}`);
      return null;
    }
    state.upstream.lastError = null;
    ensureDir(outputRoot);
    upstreamConfigDir = mkdtempSync(join(tmpdir(), "browser-lane-"));
    const configPath = join(upstreamConfigDir, "config.json");
    writeFileSync(configPath, JSON.stringify(config));
    const args = [
      cli,
      ...upstreamArgs({
        configPath,
        port: upstreamPort,
        outputRoot,
        host: (env.BROWSER_SHARED_UPSTREAM_HOST || "127.0.0.1").trim(),
      }),
    ];
    logger.log(`[browser-lane] starting shared playwright MCP on port ${upstreamPort} (one per pod)`);
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "inherit", "inherit"],
      env,
      detached: false,
    });
    child.on("error", (err) => {
      logger.error(`[browser-lane] shared playwright MCP failed to start: ${err?.message || err}`);
    });
    // If this service dies abruptly (timeout kill, OOM, SIGKILL) the CLI must
    // not survive holding the port — the next start would then loop on
    // EADDRINUSE (seen while running the smoke locally, 2026-11-08).
    process.on("exit", () => {
      try {
        if (child.exitCode === null) child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    });
    child.on("exit", (code, signal) => {
      state.upstream.pid = null;
      state.upstream.reachable = false;
      state.upstream.lastExit = { code, signal, at: Date.now() };
      if (stopping) return;
      state.upstream.restarts += 1;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(state.upstream.restarts - 1, 5));
      logger.warn(
        `[browser-lane] shared playwright MCP exited (code=${code ?? "null"} signal=${signal ?? "none"}); ` +
          `restarting in ${delay}ms — cells degrade meanwhile, nothing falls back to a per-cell process`,
      );
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (stopping) return;
        upstreamProc = spawnUpstream();
        state.upstream.pid = upstreamProc?.pid ?? null;
      }, delay);
      restartTimer.unref?.();
    });
    return child;
  }

  async function ensureUpstream({ timeoutMs = attachUrl ? 1500 : 30000 } = {}) {
    const ready = attachUrl
      ? await waitForListening({
          host: new URL(upstreamBase).hostname,
          port: Number(new URL(upstreamBase).port || 80),
          timeoutMs,
          isAborted: () => stopping,
        })
      : await waitForListening({
          host: "127.0.0.1",
          port: upstreamPort,
          timeoutMs,
          isAborted: () => stopping || state.upstream.pid == null,
        });
    state.upstream.reachable = ready;
    if (!ready) {
      logger.error(`[browser-lane] browser lane unavailable at shared endpoint ${sseUrl}`);
    }
    return ready;
  }

  // ── one cell session (1.1 / 1.3 / 1.4 / 1.5) ─────────────────────────────
  async function openSession(req) {
    // Identity: from the connection's peer process, never from the request.
    let peer = { cellId: null, reason: "not_attempted" };
    try {
      peer = resolveIdentity(req.socket) ?? { cellId: null, reason: "resolver_returned_null" };
    } catch (err) {
      peer = { cellId: null, reason: `resolver_error: ${err?.message || err}` };
    }
    const sessionId = randomUUID();
    const artifactDir = ensureDir(
      artifactDirForCell({ cellId: peer.cellId, cellsRoot, outputRoot, sessionId }),
    );

    const upstream = new Client(
      { name: "browser-lane-shared-frontend", version: SERVICE_VERSION },
      { capabilities: {} },
    );
    try {
      await upstream.connect(new SSEClientTransport(new URL(sseUrl)));
    } catch (err) {
      // A dead upstream must not leave a reconnecting client behind: the cell
      // degrades (its MCP entry fails) and this session is never registered.
      await upstream.close().catch(() => {});
      logger.error(`[browser-lane] browser lane unavailable at shared endpoint ${sseUrl}: ${err?.message || err}`);
      throw err;
    }
    const session = {
      id: sessionId,
      cellId: peer.cellId ?? null,
      identityReason: peer.reason ?? null,
      artifactDir,
      upstream,
      transport: null,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      calls: 0,
    };

    const server = new Server(
      { name: "playwright", version: SERVICE_VERSION },
      { capabilities: { tools: {} } },
    );
    // tools/list is answered from THIS session's upstream session: two cells
    // share the process, never the session (1.1).
    server.setRequestHandler(ListToolsRequestSchema, async () => upstream.listTools());
    server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
      forwardCall({ session, request, extra }),
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => session.id,
      onsessioninitialized: (id) => {
        sessions.set(id, session);
      },
    });
    session.transport = transport;
    transport.onclose = () => void closeSession(session.id, "transport closed");
    await server.connect(transport);
    session.server = server;

    if (!peer.cellId) {
      logger.warn(
        `[browser-lane] session ${sessionId.slice(0, 8)} has NO trusted cell identity (${peer.reason}); ` +
          `artifacts go to ${artifactDir} — a client-supplied identity is never used`,
      );
    } else {
      logger.log(
        `[browser-lane] session ${sessionId.slice(0, 8)} bound to cell ${peer.cellId} (via ${peer.attributedVia}); ` +
          `artifacts → ${artifactDir}`,
      );
    }
    return session;
  }

  async function forwardCall({ session, request, extra }) {
    const startedAt = Date.now();
    // What the shared root already held. Adoption diffs against this NAME SET
    // rather than the clock: filesystem timestamps are floored to the FS tick
    // (1-10ms), so a fast call's auto-named file can read as older than
    // `startedAt` and be left behind — where the next cell sweeps it up. See
    // newFilesSince() for the cross-cell leak this closes.
    const artifactsBefore = listArtifactNames(outputRoot);
    const { args, rewritten } = rewriteArtifactArgs(request.params.arguments, session.artifactDir);
    if (rewritten.length) {
      logger.log(
        `[browser-lane] cell ${session.cellId ?? "unknown"} ${request.params.name}: ` +
          rewritten.map((r) => `${r.key}→${r.to}`).join(", "),
      );
    }
    const progressToken = request.params._meta?.progressToken;
    session.calls += 1;
    state.calls += 1;
    try {
      const result = await session.upstream.callTool(
        { name: request.params.name, arguments: args },
        undefined,
        {
          // Long navigations are the norm here; resetTimerOnProgress +
          // a generous ceiling keeps a slow page from looking like a hang
          // while still bounding a truly stuck call.
          timeout: callTimeoutMs,
          resetTimeoutOnProgress: true,
          signal: extra.signal,
          ...(progressToken != null
            ? {
                onprogress: (p) => {
                  extra
                    .sendNotification({
                      method: "notifications/progress",
                      params: {
                        progressToken,
                        progress: p.progress,
                        ...(p.total != null ? { total: p.total } : {}),
                        ...(p.message != null ? { message: p.message } : {}),
                      },
                    })
                    .catch(() => {});
                },
              }
            : {}),
        },
      );
      // Unnamed artifacts (auto-named snapshots) landed in the shared root
      // during this call — move the ones this call produced into the cell dir.
      adoptNewFiles({ root: outputRoot, into: session.artifactDir, sinceMs: startedAt, before: artifactsBefore });
      return result;
    } catch (err) {
      // Error-code fidelity: an upstream McpError keeps its code/message/data
      // so the cell sees the same verdict it would have seen per-cell.
      if (err instanceof McpError) throw err;
      if (err?.name === "AbortError") {
        throw new McpError(ErrorCode.InvalidRequest, "request cancelled");
      }
      throw new McpError(ErrorCode.InternalError, err?.message || String(err));
    }
  }

  async function closeSession(id, why) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    try {
      await session.upstream?.close?.();
    } catch {
      /* already gone */
    }
    logger.log(`[browser-lane] session ${String(id).slice(0, 8)} closed (${why})`);
  }

  // ── http face ────────────────────────────────────────────────────────────
  function healthSnapshot() {
    return {
      ok: state.upstream.reachable,
      uptimeMs: state.startedAt ? Date.now() - state.startedAt : 0,
      sessions: sessions.size,
      calls: state.calls,
      artifactRoot: outputRoot,
      upstream: { ...state.upstream },
      sessionIdleMs,
      cells: [...sessions.values()].map((s) => ({
        cellId: s.cellId,
        calls: s.calls,
        since: s.createdAt,
        idleMs: Date.now() - s.lastActivity,
      })),
    };
  }

  async function handle(req, res) {
    const url = new URL(req.url || "/", `http://${host}:${port}`);
    if (url.pathname === "/healthz" && req.method === "GET") {
      const reachable = await probeListening(
        { host: new URL(upstreamBase).hostname, port: Number(new URL(upstreamBase).port || 80) },
      ).catch(() => false);
      state.upstream.reachable = reachable;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(healthSnapshot()));
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
      return;
    }
    // Cell identity comes from the peer process; a query string or header that
    // claims one is ignored — and worth a line when someone tries it.
    if (url.searchParams.has("cell") || req.headers["x-cell-id"] || req.headers["x-browser-cell"]) {
      logger.warn(
        "[browser-lane] a client tried to declare its own cell — ignored; identity is resolved from the peer process",
      );
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
    const sid = req.headers["mcp-session-id"];
    const known = typeof sid === "string" ? sessions.get(sid) : null;

    try {
      if (!known && req.method === "POST" && isInitializeRequest(body)) {
        const session = await openSession(req);
        await session.transport.handleRequest(req, res, body);
        return;
      }
      if (!known) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: no valid session (initialize first)" },
            id: null,
          }),
        );
        return;
      }
      known.lastActivity = Date.now();
      await known.transport.handleRequest(req, res, body);
    } catch (err) {
      logger.error(`[browser-lane] request failed: ${err?.message || err}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null }));
      }
    }
  }

  return {
    get port() {
      return port;
    },
    get host() {
      return host;
    },
    get outputRoot() {
      return outputRoot;
    },
    get upstream() {
      return state.upstream;
    },
    healthSnapshot,
    sessions,
    async start() {
      stopping = false;
      state.startedAt = Date.now();
      ensureDir(outputRoot);
      if (!attachUrl) {
        upstreamProc = spawnUpstream();
        state.upstream.pid = upstreamProc?.pid ?? null;
        if (!upstreamProc) {
          throw new Error(state.upstream.lastError || "shared playwright MCP could not be launched (see log)");
        }
      }
      const ready = await ensureUpstream();
      if (!ready) {
        // Keep serving: the frontend answering lets cells fail fast with a clear
        // reason, and the supervisor will keep retrying the upstream.
        logger.warn(`[browser-lane] serving ${host}:${port} while the upstream is not reachable at ${sseUrl}`);
      }
      httpServer = createHttpServer((req, res) => {
        void handle(req, res);
      });
      await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, resolve);
      });
      logger.log(`[browser-lane] streamable-http frontend listening on ${host}:${port}/mcp`);
      if (sessionIdleMs > 0) {
        sweepTimer = setInterval(() => {
          const now = Date.now();
          for (const [id, session] of [...sessions.entries()]) {
            if (now - session.lastActivity <= sessionIdleMs) continue;
            logger.log(
              `[browser-lane] retiring idle session ${String(id).slice(0, 8)} ` +
                `(cell ${session.cellId ?? "unknown"}, idle ${Math.round((now - session.lastActivity) / 1000)}s)`,
            );
            void closeSession(id, "idle");
          }
        }, sessionSweepMs);
        sweepTimer.unref?.();
      }
      return this;
    },
    async stop() {
      stopping = true;
      if (restartTimer) clearTimeout(restartTimer);
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
      for (const id of [...sessions.keys()]) await closeSession(id, "service stopping");
      if (httpServer) {
        await new Promise((r) => {
          httpServer.close(r);
          httpServer.closeAllConnections?.();
        });
      }
      httpServer = null;
      if (upstreamProc && upstreamProc.exitCode === null) {
        upstreamProc.kill("SIGTERM");
        upstreamProc = null;
      }
      if (upstreamConfigDir) {
        try {
          rmSync(upstreamConfigDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
        upstreamConfigDir = null;
      }
      state.upstream.pid = null;
      state.upstream.reachable = false;
    },
  };
}

// Entry point (`node server/browser-lane-service.js`).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = createBrowserLaneService();
  const shutdown = async (signal) => {
    console.log(`[browser-lane] ${signal} — shutting down`);
    await service.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  service.start().catch((err) => {
    console.error(`[browser-lane] failed to start: ${err?.message || err}`);
    process.exit(1);
  });
}
